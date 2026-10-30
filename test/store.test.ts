import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ExecOutput } from "../src/boxd/sdk.js";
import { fsStore, machineStore, type Store, type StoreBoxd } from "../src/boxd/store.js";

/** A "machine" that is this computer: exec runs bash here, upload writes a local file. */
const localMachine = (): StoreBoxd => ({
  machines: {
    exec: async (_id, p): Promise<ExecOutput> => {
      try {
        const stdout = execFileSync(p.command[0] as string, p.command.slice(1), { encoding: "utf8", stdio: "pipe" });
        return { stdout, stderr: "", exitCode: 0 };
      } catch (e) {
        const x = e as { status: number; stdout: string; stderr: string };
        return { stdout: x.stdout ?? "", stderr: x.stderr ?? "", exitCode: x.status ?? 1 };
      }
    },
    files: {
      upload: async (_id, path, source) => {
        execFileSync("bash", ["-c", `cat > '${path}'`], { input: source });
        return source.length;
      },
    },
  },
});

const stores: [string, (root: string) => Store][] = [
  ["fsStore", (root) => fsStore(root)],
  ["machineStore", (root) => machineStore(localMachine(), "m1", root)],
];

describe.each(stores)("%s", (_name, make) => {
  test("writes, reads back, and lists, with private files", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxd-ci-store-"));
    const s = make(root);
    expect(await s.read("runs/acme-web/1.json")).toBeNull();
    expect(await s.list("runs/acme-web")).toEqual([]);
    await s.write("runs/acme-web/1.json", '{"a":1}');
    await s.write("runs/acme-web/2.json", '{"it\'s":2}');
    expect(await s.read("runs/acme-web/2.json")).toBe('{"it\'s":2}');
    expect(await s.list("runs/acme-web")).toEqual(["1.json", "2.json"]);
    expect(statSync(join(root, "runs/acme-web/1.json")).mode & 0o777).toBe(0o600);
  });

  test("reads many files at once, null for the missing ones", async () => {
    const s = make(mkdtempSync(join(tmpdir(), "boxd-ci-store-")));
    await s.write("runs/a/1.json", '{"n":1}');
    await s.write("runs/a/3.json", "line one\nline two\n");
    expect(await s.readMany(["runs/a/1.json", "runs/a/2.json", "runs/a/3.json"])).toEqual([
      '{"n":1}',
      null,
      "line one\nline two\n",
    ]);
    expect(await s.readMany([])).toEqual([]);
  });

  test("refuses a path that leaves the root", async () => {
    const s = make(mkdtempSync(join(tmpdir(), "boxd-ci-store-")));
    await expect(s.read("../etc/passwd")).rejects.toThrow("not a store path");
    await expect(s.write("runs/../../x", "")).rejects.toThrow("not a store path");
  });
});

describe("fsStore as root (the automation)", () => {
  test("hands every folder and file it creates to the owner of the state folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxd-ci-store-"));
    const given: string[] = [];
    const s = fsStore(root, {
      isRoot: () => true,
      chown: async (p, uid, gid) => {
        given.push(`${p.slice(root.length)} ${uid === statSync(root).uid && gid === statSync(root).gid}`);
      },
    });
    await s.write("runs/acme-web/1.json", "{}");
    await s.write("runs/acme-web/2.json", "{}");
    expect(given.filter((g) => !g.includes(".tmp"))).toEqual([
      "/runs true",
      "/runs/acme-web true",
      "/runs/acme-web/1.json true",
      "/runs/acme-web/2.json true",
    ]);
  });
});
