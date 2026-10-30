// boxd-ci keeps its state as files on the server machine: the repositories it knows, their snapshots,
// and every run. Inside that machine (the GitHub automation) they are local files; from a laptop
// they are the same files, reached through the boxd API.

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
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
}

export type StoreBoxd = { machines: Pick<BoxdLike["machines"], "exec" | "files"> };

const safe = (path: string): string => {
  const p = normalize(path);
  if (p.startsWith("..") || p.startsWith("/") || p.includes("\0")) throw new Error(`not a store path: ${path}`);
  return p;
};

export function fsStore(root: string): Store {
  return {
    async read(path) {
      return readFile(join(root, safe(path)), "utf8").catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
    },
    async write(path, data) {
      const file = join(root, safe(path));
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, file);
    },
    async list(dir) {
      const names = await readdir(join(root, safe(dir))).catch(() => [] as string[]);
      return names.filter((n) => !n.endsWith(".tmp")).sort();
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
      const tmp = `/tmp/boxd-ci-${Math.random().toString(36).slice(2)}`;
      await boxd.machines.files.upload(machineId, tmp, new TextEncoder().encode(data));
      const out = await sh(`mkdir -p -m 700 ${q(dirname(file))} && chmod 600 ${q(tmp)} && mv -f ${q(tmp)} ${q(file)}`);
      if (out.exitCode !== 0) throw new Error(`writing ${file} failed: ${out.stderr.trim()}`);
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
