import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { CreateParams, ExecOutput, SnapshotInfo } from "../src/boxd/sdk.js";
import {
  buildSnapshot,
  depsHashScript,
  depsSnapshotName,
  installScript,
  promote,
  type RepoRecord,
  repoSlug,
  type SnapshotBoxd,
  saveSnapshot,
} from "../src/boxd/snapshot.js";

const bash = (script: string, env: Record<string, string> = {}) =>
  execFileSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } }).trim();

describe("repoSlug and names", () => {
  test("a repository becomes a lowercase name boxd accepts", () => {
    expect(repoSlug("Azin-Tech/bench.AI")).toBe("azin-tech-bench-ai");
    expect(depsSnapshotName("azin-tech/bench-ai", "0123456789abcdef")).toBe("bci-azin-tech-bench-ai-deps-0123456789");
  });
});

describe("depsHashScript", () => {
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), "boxd-ci-deps-"));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    writeFileSync(join(dir, "README.md"), "hi\n");
    return dir;
  };

  test("changes with the lockfile and the patches folder, and nothing else", () => {
    const dir = repo();
    const h = () => bash(depsHashScript(dir));
    const first = h();
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    writeFileSync(join(dir, "README.md"), "changed\n");
    expect(h()).toBe(first);
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\npackages: {}\n");
    const second = h();
    expect(second).not.toBe(first);
    mkdirSync(join(dir, "patches"));
    writeFileSync(join(dir, "patches", "x.patch"), "diff\n");
    expect(h()).not.toBe(second);
  });
});

describe("installScript", () => {
  /** A repo with the given files and stub tools that print how they were called. */
  const run = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "boxd-ci-install-"));
    const bin = join(dir, ".bin");
    mkdirSync(bin);
    for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
    for (const tool of ["pnpm", "npm", "yarn", "bun", "sudo"]) {
      writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*"\n`);
      chmodSync(join(bin, tool), 0o755);
    }
    writeFileSync(join(bin, "node"), '#!/bin/sh\necho "v24.22.1"\n');
    chmodSync(join(bin, "node"), 0o755);
    return bash(installScript(dir), { PATH: `${bin}:/usr/bin:/bin` });
  };

  test("installs with the repository's own package manager, from its lockfile", () => {
    expect(run({ "pnpm-lock.yaml": "" })).toContain("pnpm install --frozen-lockfile");
    expect(run({ "bun.lock": "" })).toContain("bun install --frozen-lockfile");
    expect(run({ "yarn.lock": "", ".yarnrc.yml": "" })).toContain("yarn install --immutable");
    expect(run({ "yarn.lock": "" })).toContain("yarn install --frozen-lockfile");
    expect(run({ "package-lock.json": "" })).toContain("npm ci");
  });

  test("turns on corepack so pnpm and yarn follow packageManager", () => {
    expect(run({ "pnpm-lock.yaml": "" })).toContain("sudo corepack enable --install-directory /usr/local/bin");
  });

  test("keeps the installed Node.js when it is the version the repository asks for", () => {
    expect(run({ "package-lock.json": "", ".nvmrc": "24\n" })).not.toContain("nvm");
  });
});

/** Records calls; snapshots become ready after `readyAfter` polls. */
class FakeBoxd implements SnapshotBoxd {
  log: string[] = [];
  creates: CreateParams[] = [];
  execs: { script: string; env: Record<string, string> }[] = [];
  snaps = new Map<string, SnapshotInfo>();
  readyAfter = 1;
  failOn?: string;
  depsHash = "aaaaaaaaaaaaaaaa";
  notAncestor = false;
  private n = 0;
  private polls = 0;

  machines = {
    create: async (p: CreateParams) => {
      this.creates.push(p);
      this.n += 1;
      this.log.push(`create ${"fromSnapshot" in p ? p.fromSnapshot : "image"}`);
      return { id: `b${this.n}`, name: p.name };
    },
    waitUntilReady: async () => {},
    exec: async (_id: string, p: { command: string[]; env?: Record<string, string> }): Promise<ExecOutput> => {
      const script = p.command[2] ?? "";
      this.execs.push({ script, env: p.env ?? {} });
      const step = script.includes("clone")
        ? "clone"
        : script.includes("merge-base --is-ancestor")
          ? "ancestor"
          : script.includes("fetch -q origin")
            ? "fetch"
            : script.includes("sha256sum")
              ? "hash"
              : script.includes("--frozen-lockfile")
                ? "install"
                : script.includes("turbo run")
                  ? "warm"
                  : "other";
      this.log.push(step);
      if (step === this.failOn) return { stdout: "", stderr: `${step} broke`, exitCode: 1 };
      if (step === "hash") return { stdout: `${this.depsHash}\n`, stderr: "", exitCode: 0 };
      if (step === "ancestor") return { stdout: "", stderr: "", exitCode: this.notAncestor ? 1 : 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    delete: async (id: string) => {
      this.log.push(`delete ${id}`);
    },
  };
  snapshots = {
    create: async (machine: string, name: string) => {
      this.log.push(`save ${machine} ${name}`);
      const version = (this.snaps.get(name)?.version ?? 0) + 1;
      this.snaps.set(name, { name, version: version - 1 || null, status: "pending", vcpu: 2 });
      this.polls = 0;
      return { version };
    },
    get: async (name: string) => {
      const s = this.snaps.get(name);
      if (!s) throw new Error("not found");
      this.polls += 1;
      if (this.polls >= this.readyAfter && s.status === "pending") {
        s.status = name === "broken" ? "failed" : "ready";
        s.version = (s.version ?? 0) + 1;
      }
      return { ...s };
    },
  };
}

const record = (o: Partial<RepoRecord> = {}): RepoRecord => ({
  version: 1,
  repo: "acme/web",
  cloneUrl: "https://github.com/acme/web.git",
  defaultBranch: "main",
  workdir: "/home/boxd/work/web",
  slots: ["bci-acme-web-a", "bci-acme-web-b"],
  snapshot: "bci-acme-web-a",
  commit: "c0ffee1",
  depsHash: "aaaaaaaaaaaaaaaa",
  cpus: 2,
  builtAt: "2026-10-30T00:00:00.000Z",
  ...o,
});

describe("saveSnapshot", () => {
  test("waits until the new version is ready", async () => {
    const boxd = new FakeBoxd();
    boxd.readyAfter = 3;
    expect(await saveSnapshot(boxd, "m1", "s1", { pollMs: 1 })).toBe(1);
    expect(boxd.snaps.get("s1")?.status).toBe("ready");
  });

  test("a snapshot that fails to save is an error", async () => {
    const boxd = new FakeBoxd();
    await expect(saveSnapshot(boxd, "m1", "broken", { pollMs: 1 })).rejects.toThrow("snapshot broken failed");
  });
});

describe("buildSnapshot", () => {
  const opts = {
    org: "acme",
    repo: { repo: "acme/web", cloneUrl: "https://github.com/acme/web.git", defaultBranch: "main" },
    sha: "c0ffee1",
    fetchToken: "ghs_x",
    env: { TURBO_TOKEN: "t", CI: "1" },
    selectors: ["web#test"],
    pollMs: 1,
  };

  test("clones, installs, fills the cache, saves the first slot, and deletes the builder", async () => {
    const boxd = new FakeBoxd();
    const r = await buildSnapshot(boxd, opts);
    expect(boxd.creates[0]).toMatchObject({
      org: "acme",
      config: { vcpu: 2, memory: "8G", autoSuspendTimeout: 0 },
      isolated: true,
      deleteAfter: 7200,
      labels: { "boxd-ci": "builder" },
    });
    expect(boxd.log).toEqual([
      "create image",
      "clone",
      "install",
      "hash",
      "warm",
      "save b1 bci-acme-web-a",
      "delete b1",
    ]);
    expect(boxd.execs.find((e) => e.script.includes("clone"))?.env).toEqual({ BOXD_CI_FETCH_TOKEN: "ghs_x" });
    expect(boxd.execs.filter((e) => e.env.BOXD_CI_FETCH_TOKEN)).toHaveLength(1);
    expect(boxd.execs.find((e) => e.script.includes("turbo run"))?.env).toMatchObject({ TURBO_TOKEN: "t" });
    expect(r).toMatchObject({
      repo: "acme/web",
      workdir: "/home/boxd/work/web",
      slots: ["bci-acme-web-a", "bci-acme-web-b"],
      snapshot: "bci-acme-web-a",
      commit: "c0ffee1",
      depsHash: "aaaaaaaaaaaaaaaa",
      cpus: 2,
    });
  });

  test("a failed install deletes the builder and says what broke", async () => {
    const boxd = new FakeBoxd();
    boxd.failOn = "install";
    await expect(buildSnapshot(boxd, opts)).rejects.toThrow("installing dependencies failed: install broke");
    expect(boxd.log.at(-1)).toBe("delete b1");
  });
});

describe("promote", () => {
  const opts = (r: RepoRecord) => ({
    org: "acme",
    record: r,
    sha: "d00d2",
    fetchToken: "ghs_x",
    env: { CI: "1" },
    selectors: ["web#test"],
    pollMs: 1,
  });

  test("restores the current snapshot, checks out the commit, and saves it to the other slot", async () => {
    const boxd = new FakeBoxd();
    const next = await promote(boxd, opts(record()));
    expect(boxd.log).toEqual([
      "create bci-acme-web-a",
      "fetch",
      "ancestor",
      "hash",
      "warm",
      "save b1 bci-acme-web-b",
      "delete b1",
    ]);
    expect(next).toMatchObject({ snapshot: "bci-acme-web-b", commit: "d00d2" });
  });

  test("installs only when the dependency files changed", async () => {
    const boxd = new FakeBoxd();
    boxd.depsHash = "bbbbbbbbbbbbbbbb";
    const next = await promote(boxd, opts(record()));
    expect(boxd.log).toContain("install");
    expect(next?.depsHash).toBe("bbbbbbbbbbbbbbbb");
  });

  test("a commit older than the snapshot's is not promoted", async () => {
    const boxd = new FakeBoxd();
    boxd.notAncestor = true;
    expect(await promote(boxd, opts(record()))).toBeNull();
    expect(boxd.log.some((l) => l.startsWith("save"))).toBe(false);
    expect(boxd.log.at(-1)).toBe("delete b1");
  });
});
