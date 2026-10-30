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

  test("refuses a path that leaves the root", async () => {
    const s = make(mkdtempSync(join(tmpdir(), "boxd-ci-store-")));
    await expect(s.read("../etc/passwd")).rejects.toThrow("not a store path");
    await expect(s.write("runs/../../x", "")).rejects.toThrow("not a store path");
  });
});
