// boxd-turbo keeps its state as files on the server machine: the repositories it knows, their snapshots,
// and every run. Inside that machine (the GitHub automation) they are local files; from a laptop
// they are the same files, reached through the boxd API.

import { statSync } from "node:fs";
import { chown, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { q } from "./scripts.js";
import type { BoxdLike } from "./sdk.js";

export interface Store {
  /** The file's text, or null when there is none. */
  read(path: string): Promise<string | null>;
  /** Replaces the file in one step, readable by its owner only. */
  write(path: string, data: string): Promise<void>;
  /** The names of the files in a directory, sorted; empty when there is none. */
  list(dir: string): Promise<string[]>;
  /** The text of each file, null for the missing ones, in one round trip. */
  readMany(paths: string[]): Promise<(string | null)[]>;
}

export type StoreBoxd = { machines: Pick<BoxdLike["machines"], "exec" | "files"> };

const safe = (path: string): string => {
  const p = normalize(path);
  if (p.startsWith("..") || p.startsWith("/") || p.includes("\0")) throw new Error(`not a store path: ${path}`);
  return p;
};

export type FsStoreOptions = {
  isRoot?: () => boolean;
  chown?: (path: string, uid: number, gid: number) => Promise<void>;
};

/**
 * The files themselves, for code running on the server. The automation runs as root there, so what
 * it creates is handed to the state folder's owner: the CLI reads it as that user.
 */
export function fsStore(root: string, o: FsStoreOptions = {}): Store {
  const isRoot = o.isRoot ?? (() => process.getuid?.() === 0);
  const give = async (paths: string[]) => {
    if (!isRoot()) return;
    const { uid, gid } = statSync(root);
    for (const p of paths) await (o.chown ?? chown)(p, uid, gid).catch(() => {});
  };
  return {
    async read(path) {
      return readFile(join(root, safe(path)), "utf8").catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
    },
    async write(path, data) {
      const file = join(root, safe(path));
      const dir = dirname(file);
      const made = await mkdir(dir, { recursive: true, mode: 0o700 });
      if (made) {
        // Every folder from the first one created down to the file's.
        const dirs: string[] = [];
        for (let d = dir; d.length >= made.length; d = dirname(d)) dirs.unshift(d);
        await give(dirs);
      }
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, data, { mode: 0o600 });
      await give([tmp]);
      await rename(tmp, file);
      if (isRoot()) await give([file]);
    },
    async list(dir) {
      const names = await readdir(join(root, safe(dir))).catch(() => [] as string[]);
      return names.filter((n) => !n.endsWith(".tmp")).sort();
    },
    async readMany(paths) {
      return Promise.all(paths.map((p) => this.read(p)));
    },
  };
}

export function machineStore(boxd: StoreBoxd, machineId: string, root: string): Store {
  const sh = async (script: string) => {
    const out = await boxd.machines.exec(machineId, { command: ["bash", "-c", script] });
    return out;
  };
  return {
    async read(path) {
      const file = join(root, safe(path));
      const out = await sh(`if [ -f ${q(file)} ]; then cat ${q(file)}; else exit 3; fi`);
      if (out.exitCode === 3) return null;
      if (out.exitCode !== 0) throw new Error(`reading ${file} failed: ${out.stderr.trim()}`);
      return out.stdout;
    },
    async write(path, data) {
      const file = join(root, safe(path));
      const tmp = `/tmp/boxd-turbo-${Math.random().toString(36).slice(2)}`;
      await boxd.machines.files.upload(machineId, tmp, new TextEncoder().encode(data));
      const out = await sh(`mkdir -p -m 700 ${q(dirname(file))} && chmod 600 ${q(tmp)} && mv -f ${q(tmp)} ${q(file)}`);
      if (out.exitCode !== 0) throw new Error(`writing ${file} failed: ${out.stderr.trim()}`);
    },
    async readMany(paths) {
      if (!paths.length) return [];
      // Each file comes back as F<text> or N (missing), separated by NUL bytes, which JSON and logs never hold.
      const files = paths.map((p) => q(join(root, safe(p)))).join(" ");
      const out = await sh(
        `for f in ${files}; do if [ -f "$f" ]; then printf F; cat "$f"; else printf N; fi; printf '\\0'; done`,
      );
      if (out.exitCode !== 0) throw new Error(`reading ${paths.length} files failed: ${out.stderr.trim()}`);
      return out.stdout
        .split("\0")
        .slice(0, paths.length)
        .map((chunk) => (chunk.startsWith("F") ? chunk.slice(1) : null));
    },
    async list(dir) {
      const out = await sh(`ls -1 ${q(join(root, safe(dir)))} 2>/dev/null || true`);
      return out.stdout
        .split("\n")
        .filter((n) => n && !n.endsWith(".tmp"))
        .sort();
    },
  };
}
