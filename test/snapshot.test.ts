import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { CreateParams, ExecOutput, SnapshotInfo } from "../src/boxd/sdk.js";
import {
  buildSnapshot,
  cloneScript,
  DEPS_HASH_MARK,
  depsHashScript,
  depsSnapshotName,
  devSnapshotName,
  installScript,
  promote,
  pruneSnapshots,
  type RepoRecord,
  repoSlug,
  runSnapshotName,
  type SnapshotBoxd,
  saveDepsSnapshot,
  saveSnapshot,
} from "../src/boxd/snapshot.js";
import type { BoxWorker } from "../src/boxd/worker.js";

const bash = (script: string, env: Record<string, string> = {}) =>
  execFileSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } }).trim();

describe("repoSlug and names", () => {
  test("two long names that share their first 40 characters keep different slugs", () => {
    const a = repoSlug("acme-engineering/payments-dashboard-service-api");
    const b = repoSlug("acme-engineering/payments-dashboard-service-app");
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(40);
    expect(a).toMatch(/^acme-engineering-payments-[a-z0-9-]*-[0-9a-f]{6}$/);
  });

  test("a repository becomes a lowercase name boxd accepts", () => {
    expect(repoSlug("Azin-Tech/bench.AI")).toBe("azin-tech-bench-ai");
    expect(depsSnapshotName("azin-tech/bench-ai", "0123456789abcdef")).toBe("bci-azin-tech-bench-ai-deps-0123456789");
  });

  test("dependency snapshots name who made them, and stay within 63 characters for the longest slug", () => {
    const long = "acme-engineering/payments-dashboard-service-api";
    expect(devSnapshotName("acme/web", "0123456789abcdef")).toBe("bci-acme-web-dev-0123456789");
    expect(runSnapshotName("acme/web", "0123456789abcdef", "x7k2")).toBe("bci-acme-web-run-012345x7k2");
    for (const n of [
      depsSnapshotName(long, "0".repeat(16)),
      devSnapshotName(long, "0".repeat(16)),
      runSnapshotName(long, "0".repeat(16), "abcd"),
    ])
      expect(n.length).toBeLessThanOrEqual(63);
  });
});

describe("depsHashScript", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });
  const pkg = (deps: Record<string, string>, extra: Record<string, unknown> = {}) =>
    `${JSON.stringify({ name: "a", version: "1.0.0", scripts: { build: "tsc" }, dependencies: deps, ...extra }, null, 2)}\n`;
  /** A committed repository with a root package, one workspace package, and (unless told) a lockfile. */
  const repo = (o: { lockfile?: boolean } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "boxd-ci-deps-"));
    if (o.lockfile !== false) writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    writeFileSync(join(dir, "README.md"), "hi\n");
    writeFileSync(join(dir, "package.json"), pkg({}, { name: "root" }));
    mkdirSync(join(dir, "packages", "a"), { recursive: true });
    writeFileSync(join(dir, "packages", "a", "package.json"), pkg({ zod: "^3.0.0" }));
    git(dir, "init", "-q");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "one");
    return dir;
  };

  test("changes with the lockfile and the patches folder, and not with other files", () => {
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

  test("changes when a package.json changes what gets installed, and not when only its scripts or version do", () => {
    const dir = repo();
    const file = join(dir, "packages", "a", "package.json");
    const h = () => bash(depsHashScript(dir));
    const first = h();
    writeFileSync(file, pkg({ zod: "^3.0.0" }, { version: "2.0.0", scripts: { build: "tsc -b" } }));
    expect(h()).toBe(first);
    writeFileSync(file, pkg({ zod: "^4.0.0" }));
    const bumped = h();
    expect(bumped).not.toBe(first);
    writeFileSync(file, pkg({ zod: "^4.0.0" }, { scripts: { build: "tsc", postinstall: "node setup.js" } }));
    expect(h()).not.toBe(bumped);
  });

  test("a new workspace package changes it, before anyone commits it", () => {
    const dir = repo();
    const first = bash(depsHashScript(dir));
    mkdirSync(join(dir, "packages", "b"));
    writeFileSync(join(dir, "packages", "b", "package.json"), pkg({}, { name: "b" }));
    expect(bash(depsHashScript(dir))).not.toBe(first);
  });

  test("a lockfile git does not track, which an install without one writes, is not part of it", () => {
    const dir = repo({ lockfile: false });
    const first = bash(depsHashScript(dir));
    writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}\n');
    expect(bash(depsHashScript(dir))).toBe(first);
  });

  test("carries a marker, so tests and logs can tell it apart", () => {
    expect(depsHashScript("/w")).toContain(DEPS_HASH_MARK);
  });
});

describe("cloneScript", () => {
  test("clones with the token as a github.com header from the environment, then checks out with submodules", () => {
    const s = cloneScript("https://github.com/acme/web.git", "/home/boxd/work/web", "abc1234");
    expect(s).toContain("GIT_CONFIG_KEY_0=http.https://github.com/.extraheader");
    expect(s).toContain("clone -q 'https://github.com/acme/web.git' '/home/boxd/work/web'");
    expect(s).toContain("checkout -q -f abc1234");
    expect(s).toContain("submodule update --init --recursive");
    expect(s).not.toContain("git -c http.extraheader");
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
  /** With notAncestor: the commit is the default branch's head on GitHub (a force-push). */
  isHead = false;
  config = "";
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
      if (script.includes("boxd-ci-planner.mjs")) {
        this.log.push("plan");
        return { stdout: JSON.stringify(this.plan), stderr: "", exitCode: 0 };
      }
      const step = script.includes("clone")
        ? "clone"
        : script.includes("merge-base --is-ancestor")
          ? "ancestor"
          : script.includes(".boxd-ci.json")
            ? "config"
            : script.includes("fetch -q origin")
              ? "fetch"
              : script.includes(DEPS_HASH_MARK)
                ? "hash"
                : script.includes("--frozen-lockfile")
                  ? "install"
                  : script.includes("turbo run")
                    ? "warm"
                    : "other";
      this.log.push(step);
      if (step === this.failOn) return { stdout: "", stderr: `${step} broke`, exitCode: 1 };
      if (step === "hash") return { stdout: `${this.depsHash}\n`, stderr: "", exitCode: 0 };
      if (step === "ancestor") {
        const answer = !this.notAncestor ? "newer" : this.isHead ? "head" : "older";
        return { stdout: `${answer}\n`, stderr: "", exitCode: 0 };
      }
      if (step === "config") return { stdout: this.config, stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    delete: async (id: string) => {
      this.log.push(`delete ${id}`);
    },
    files: {
      upload: async (_id: string, path: string) => {
        this.log.push(`upload ${path}`);
        return 1;
      },
    },
  };
  plan = { selectors: [{ selector: "web#test" }, { selector: "api#lint" }] };
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
  snapshot: "bci-acme-web-c0ffee1",
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

  test("clones, installs, fills the cache, saves a snapshot named after the commit, and deletes the builder", async () => {
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
      "save b1 bci-acme-web-c0ffee1",
      "delete b1",
    ]);
    expect(boxd.execs.find((e) => e.script.includes("clone"))?.env).toEqual({ BOXD_CI_FETCH_TOKEN: "ghs_x" });
    expect(boxd.execs.filter((e) => e.env.BOXD_CI_FETCH_TOKEN)).toHaveLength(1);
    expect(boxd.execs.find((e) => e.script.includes("turbo run"))?.env).toMatchObject({ TURBO_TOKEN: "t" });
    expect(r).toMatchObject({
      repo: "acme/web",
      workdir: "/home/boxd/work/web",
      snapshot: "bci-acme-web-c0ffee1",
      commit: "c0ffee1",
      depsHash: "aaaaaaaaaaaaaaaa",
      cpus: 2,
    });
  });

  test("without selectors, the planner on the builder decides what the warm run builds", async () => {
    const boxd = new FakeBoxd();
    const { selectors: _, ...rest } = opts;
    await buildSnapshot(boxd, { ...rest, plannerBundle: new Uint8Array([1]) });
    expect(boxd.log.slice(1, 7)).toEqual([
      "clone",
      "install",
      "hash",
      "upload /tmp/boxd-ci-planner.mjs",
      "plan",
      "warm",
    ]);
    expect(boxd.execs.find((e) => e.script.includes("turbo run"))?.script).toContain("'web#test' 'api#lint'");
  });

  test("a repository with no ci task yet gets its snapshot without a warm run", async () => {
    const boxd = new FakeBoxd();
    boxd.plan = { selectors: [] };
    const { selectors: _, ...rest } = opts;
    await buildSnapshot(boxd, { ...rest, plannerBundle: new Uint8Array([1]) });
    expect(boxd.log).not.toContain("warm");
    expect(boxd.log).toContain("save b1 bci-acme-web-c0ffee1");
  });

  test("the builder gets the repository's secrets, and the record keeps the list", async () => {
    const boxd = new FakeBoxd();
    const r = await buildSnapshot(boxd, { ...opts, secrets: ["NPM_TOKEN"] });
    expect(boxd.creates[0]).toMatchObject({
      spec: { isolated: true, labels: { "boxd-ci": "builder" }, secrets: ["NPM_TOKEN"] },
    });
    expect(r.secrets).toEqual(["NPM_TOKEN"]);
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
    sha: "d00d2fe",
    fetchToken: "ghs_x",
    env: { CI: "1" },
    selectors: ["web#test"],
    pollMs: 1,
  });

  test("restores the current snapshot, checks out the commit, saves it under its own name and retires the old one", async () => {
    const boxd = new FakeBoxd();
    const next = await promote(boxd, opts(record()));
    expect(boxd.log).toEqual([
      "create bci-acme-web-c0ffee1",
      "fetch",
      "ancestor",
      "config",
      "hash",
      "warm",
      "save b1 bci-acme-web-d00d2fe",
      "delete b1",
    ]);
    expect(next).toMatchObject({
      snapshot: "bci-acme-web-d00d2fe",
      commit: "d00d2fe",
      retired: [{ name: "bci-acme-web-c0ffee1" }],
    });
  });

  test("the commit the snapshot already has is not saved again", async () => {
    const boxd = new FakeBoxd();
    expect(await promote(boxd, { ...opts(record()), sha: "c0ffee1" })).toBeNull();
    expect(boxd.creates).toHaveLength(0);
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

  test("after a force-push, the default branch's head on GitHub is promoted although it does not descend from the snapshot", async () => {
    const boxd = new FakeBoxd();
    boxd.notAncestor = true;
    boxd.isHead = true;
    const next = await promote(boxd, opts(record()));
    expect(next?.snapshot).toBe("bci-acme-web-d00d2fe");
    const ancestor = boxd.execs.find((e) => e.script.includes("merge-base --is-ancestor"));
    expect(ancestor?.script).toContain("ls-remote origin 'refs/heads/main'");
    expect(ancestor?.env).toEqual({ BOXD_CI_FETCH_TOKEN: "ghs_x" });
  });

  test("the builder gets the snapshot's secrets, and the new record takes the commit's list", async () => {
    const boxd = new FakeBoxd();
    boxd.config = '{ "secrets": ["NPM_TOKEN", "DATABASE_URL"] }';
    const next = await promote(boxd, opts(record({ secrets: ["NPM_TOKEN"] })));
    expect(boxd.creates[0]).toMatchObject({ spec: { secrets: ["NPM_TOKEN"] } });
    expect(next?.secrets).toEqual(["NPM_TOKEN", "DATABASE_URL"]);
  });
});

describe("saveDepsSnapshot", () => {
  const worker = (log: string[], failOn?: string): BoxWorker => ({
    id: "w1",
    machineId: "w1",
    cpus: 2,
    run: async () => [],
    release: async () => {},
    upload: async (path: string) => {
      log.push(`upload ${path}`);
    },
    sh: async (script: string) => {
      const step = script.includes("--frozen-lockfile")
        ? "install"
        : script.includes(" -R ")
          ? "unapply"
          : script.startsWith("rm ")
            ? "remove patch"
            : "apply";
      log.push(step);
      return {
        stdout: "",
        stderr: step === failOn ? "error: patch does not apply" : "",
        exitCode: step === failOn ? 1 : 0,
      };
    },
  });
  const patch = { path: "/tmp/boxd-ci.patch", data: new Uint8Array([1, 2, 3]) };

  test("installs, and saves the snapshot with neither the working copy nor its patch file on the machine", async () => {
    const boxd = new FakeBoxd();
    const log = boxd.log;
    const name = await saveDepsSnapshot(boxd, worker(log), {
      record: record(),
      name: "bci-acme-web-deps-bbbbbbbbbb",
      patch,
      pollMs: 1,
    });
    expect(name).toBe("bci-acme-web-deps-bbbbbbbbbb");
    expect(log).toEqual([
      "install",
      "unapply",
      "remove patch",
      "save w1 bci-acme-web-deps-bbbbbbbbbb",
      "upload /tmp/boxd-ci.patch",
      "apply",
    ]);
  });

  test("a working copy that cannot be taken back out is an error, and nothing is saved", async () => {
    const boxd = new FakeBoxd();
    await expect(
      saveDepsSnapshot(boxd, worker(boxd.log, "unapply"), {
        record: record(),
        name: "bci-acme-web-deps-bbbbbbbbbb",
        patch,
        pollMs: 1,
      }),
    ).rejects.toThrow("taking the working copy out before the snapshot failed: error: patch does not apply");
    expect(boxd.log.some((l) => l.startsWith("save"))).toBe(false);
  });
});

describe("pruneSnapshots", () => {
  test("deletes snapshots retired more than six hours ago, which no run can still be restoring", async () => {
    const deleted: string[] = [];
    const boxd = {
      snapshots: {
        delete: async (name: string) => {
          deleted.push(name);
        },
      },
    };
    const now = Date.parse("2026-10-30T20:00:00Z");
    const r = record({
      retired: [
        { name: "bci-acme-web-0000001", at: "2026-10-30T10:00:00Z" },
        { name: "bci-acme-web-0000002", at: "2026-10-30T17:00:00Z" },
      ],
    });
    const next = await pruneSnapshots(boxd, r, { now });
    expect(deleted).toEqual(["bci-acme-web-0000001"]);
    expect(next.retired).toEqual([{ name: "bci-acme-web-0000002", at: "2026-10-30T17:00:00Z" }]);
  });
});
