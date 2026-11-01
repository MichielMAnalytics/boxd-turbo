import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { RepoRecord } from "../src/boxd/snapshot.js";
import { explain, parseCli } from "../src/cli/args.js";
import { matchRun, parseRuns } from "../src/cli/commands/history.js";
import { initPlan } from "../src/cli/commands/init.js";
import { requireTurboJson, writeRegularFile } from "../src/cli/context.js";
import { anonymousRead, makePatch, parseRemote } from "../src/cli/git.js";
import { carryRetired, githubAccess, localSecrets, sameRepo } from "../src/cli/setup.js";
import { ciTaggedTasks, ownConfigs, usualChecks } from "../src/core/ci-tasks.js";

describe("parseCli", () => {
  test("a command, its flags and its arguments", () => {
    expect(parseCli(["logs", "20261030-101503-a1b2c3d", "--task", "web#test", "--json"])).toEqual({
      command: "logs",
      args: ["20261030-101503-a1b2c3d"],
      flags: { task: "web#test", json: true },
    });
    expect(parseCli(["run", "--max-machines", "8"])).toMatchObject({ command: "run", flags: { "max-machines": "8" } });
  });

  test("no command is help, --version is version", () => {
    expect(parseCli([]).command).toBe("help");
    expect(parseCli(["--version"]).command).toBe("version");
  });

  test("an unknown command or flag is an error that says what exists", () => {
    expect(() => parseCli(["deploy"])).toThrow(
      "unknown command deploy. Try init, run, ls, logs, grep, doctor or secret.",
    );
    expect(() => parseCli(["run", "--fast"])).toThrow("unknown option --fast for run");
  });
});

describe("parseRemote", () => {
  test("GitHub remotes over HTTPS and SSH become owner/name and an HTTPS clone URL", () => {
    for (const url of [
      "https://github.com/vercel/ai.git",
      "https://github.com/vercel/ai",
      "git@github.com:vercel/ai.git",
      "ssh://git@github.com/vercel/ai.git",
    ]) {
      expect(parseRemote(url)).toEqual({ repo: "vercel/ai", cloneUrl: "https://github.com/vercel/ai.git" });
    }
  });

  test("a remote that is not a repository URL is an error", () => {
    expect(() => parseRemote("/srv/git/thing")).toThrow("cannot read owner/name from the remote /srv/git/thing");
  });

  test("a remote on another host is refused before any token could be sent there", () => {
    expect(() => parseRemote("https://gitlab.com/acme/web.git")).toThrow(
      "boxd-turbo runs repositories on github.com, and origin is on gitlab.com",
    );
    expect(() => parseRemote("git@github.example.com:acme/web.git")).toThrow("origin is on github.example.com");
  });
});

describe("makePatch", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=ci@example.com", "-c", "user.name=ci", ...args], { cwd, encoding: "utf8" });

  test("the working copy against a base commit, tracked edits, deletions, new files and binaries included", () => {
    const repo = mkdtempSync(join(tmpdir(), "boxd-turbo-patch-"));
    git(repo, "init", "-q");
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    writeFileSync(join(repo, "a.txt"), "one\n");
    writeFileSync(join(repo, "gone.txt"), "bye\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    const base = git(repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    git(repo, "commit", "-qam", "a commit that is not pushed");
    writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree, not committed\n");
    rmSync(join(repo, "gone.txt"));
    writeFileSync(join(repo, "new.txt"), "untracked\n");
    writeFileSync(join(repo, "logo.bin"), Buffer.from([0, 1, 2, 255]));
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "ignored.js"), "x");
    git(repo, "add", "new.txt"); // staged state must not matter, and must stay as it was

    const patch = makePatch(repo, base);
    expect(git(repo, "diff", "--cached", "--name-only").trim()).toBe("new.txt");

    const copy = mkdtempSync(join(tmpdir(), "boxd-turbo-apply-"));
    execFileSync("git", ["clone", "-q", repo, copy]);
    git(copy, "checkout", "-q", "-f", base);
    writeFileSync(join(copy, "p.patch"), patch);
    git(copy, "apply", "--binary", "p.patch");
    rmSync(join(copy, "p.patch"));
    expect(readFileSync(join(copy, "a.txt"), "utf8")).toBe("one\ntwo\nthree, not committed\n");
    expect(readFileSync(join(copy, "new.txt"), "utf8")).toBe("untracked\n");
    expect([...readFileSync(join(copy, "logo.bin"))]).toEqual([0, 1, 2, 255]);
    expect(() => readFileSync(join(copy, "gone.txt"))).toThrow();
    expect(() => readFileSync(join(copy, "node_modules", "ignored.js"))).toThrow();
  });

  test("a clean working copy at the base is an empty patch", () => {
    const repo = mkdtempSync(join(tmpdir(), "boxd-turbo-patch-"));
    git(repo, "init", "-q");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    expect(makePatch(repo, git(repo, "rev-parse", "HEAD").trim()).length).toBe(0);
  });
});

describe("anonymousRead", () => {
  test("a repository anyone can clone needs no token, one that asks for credentials does", () => {
    const repo = mkdtempSync(join(tmpdir(), "boxd-turbo-anon-"));
    execFileSync("git", ["init", "-q", repo]);
    execFileSync(
      "git",
      ["-c", "user.email=ci@example.com", "-c", "user.name=ci", "commit", "-q", "--allow-empty", "-m", "one"],
      {
        cwd: repo,
      },
    );
    expect(anonymousRead(repo)).toBe(true);
    expect(anonymousRead(join(repo, "missing"))).toBe(false);
  });
});

describe("usualChecks", () => {
  test("the usual check tasks any turbo.json defines, plain or for one package", () => {
    expect(
      usualChecks([
        '{ "tasks": { "build": {}, "lint": {}, "web#typecheck": {} } }',
        '{ "extends": ["//"], "tasks": { "test": {} } }',
        "not json",
      ]),
    ).toEqual(["lint", "typecheck", "test"]);
    expect(usualChecks(['{ "tasks": { "build": {} } }'])).toEqual([]);
  });
});

describe("ciTaggedTasks", () => {
  test("finds the tasks tagged exactly ci, at the root and in packages, as the planner does", () => {
    expect(
      ciTaggedTasks([
        '{ "tasks": { "build": {} } }',
        '{ "extends": ["//"], "tasks": { "type-check": { "tags": ["ci"] }, "test": { "tags": ["ci:cpus:4"] } } }',
        '{ "extends": ["//"], "tasks": { "lint": { "tags": ["!ci"] } } }',
      ]),
    ).toEqual(["type-check"]);
    expect(ciTaggedTasks(['{ "tasks": { "lint": { "tags": ["!ci"] } } }', "not json"])).toEqual([]);
  });

  test("a tags value that is not a list is ignored, and a package tagged ci as a whole is named", () => {
    expect(ciTaggedTasks(['{ "tasks": { "lint": { "tags": "ci" } } }'])).toEqual([]);
    expect(ciTaggedTasks(['{ "extends": ["//"], "tags": ["ci"] }'])).toEqual(["every task of a package tagged ci"]);
  });
});

describe("ownConfigs", () => {
  test("the root's turbo.json and its packages', without another Turborepo inside the repository", () => {
    const pkg = '{ "extends": ["//"], "tasks": {} }';
    expect(
      ownConfigs([
        { path: "turbo.json", text: '{ "tasks": {} }' },
        { path: "packages/web/turbo.json", text: pkg },
        { path: "test/fixtures/mini/turbo.json", text: '{ "tasks": { "//#lint": { "tags": ["ci"] } } }' },
        { path: "test/fixtures/mini/packages/c/turbo.json", text: pkg },
        { path: "test/fixtures/minimal/turbo.jsonc", text: "not json" },
      ]),
    ).toEqual(['{ "tasks": {} }', pkg]);
  });
});

describe("init --dry-run", () => {
  test("lists what init would do, in order, without signing in to boxd", () => {
    const steps = initPlan({
      repo: "acme/web",
      org: "acme",
      server: "boxd-turbo-server",
      hasServer: false,
      hasSnapshot: false,
      github: true,
    });
    expect(steps).toEqual([
      "write .boxd-turbo.json (org acme)",
      "start boxd-turbo-server in acme: the Turborepo cache and run history",
      "build the first snapshot of acme/web from its default branch",
      "install the push automation on boxd-turbo-server and check the boxd GitHub App can read acme/web",
    ]);
  });
});

describe("repository records", () => {
  const rec = (o: Partial<RepoRecord> = {}): RepoRecord => ({
    version: 1,
    repo: "acme/web",
    cloneUrl: "https://github.com/acme/web.git",
    defaultBranch: "main",
    workdir: "/home/boxd/work/web",
    snapshot: "bt-acme-web-aaaaaaa",
    commit: "aaaaaaa",
    depsHash: "0".repeat(16),
    cpus: 2,
    builtAt: "2026-10-30T00:00:00.000Z",
    ...o,
  });

  test("a rebuild keeps the snapshots waiting to be deleted, and retires the one it replaces", () => {
    const waiting = { name: "bt-acme-web-0000000", at: "2026-10-30T00:00:00.000Z" };
    const fresh = rec({ snapshot: "bt-acme-web-bbbbbbb", commit: "bbbbbbb" });
    const next = carryRetired(rec({ retired: [waiting] }), fresh, "2026-10-30T12:00:00.000Z");
    expect(next.retired).toEqual([waiting, { name: "bt-acme-web-aaaaaaa", at: "2026-10-30T12:00:00.000Z" }]);
    expect(carryRetired(undefined, fresh, "2026-10-30T12:00:00.000Z").retired).toBeUndefined();
  });

  test("another repository whose name maps to the same record is refused", () => {
    expect(() => sameRepo(rec({ repo: "acme/my.app" }), "acme/my_app")).toThrow(
      "acme/my_app and acme/my.app have the same short name in boxd (acme-my-app), and boxd-turbo already runs acme/my.app. One account runs one of them.",
    );
    expect(() => sameRepo(rec({ repo: "Acme/Web" }), "acme/web")).not.toThrow();
  });
});

describe("first-run errors", () => {
  test("an error about missing or expired boxd credentials says how to sign in", () => {
    const how = "you are not signed in to boxd. Run boxd auth login, or set BOXD_API_KEY.";
    expect(explain("no credentials: pass { apiKey } or { token }, or set BOXD_API_KEY / BOXD_TOKEN")).toBe(how);
    expect(explain("UNAUTHENTICATED: token expired")).toBe(how);
    expect(explain("the server did not answer")).toBe("the server did not answer");
  });

  test("a folder without turbo.json is refused before anything starts in the cloud", () => {
    const dir = mkdtempSync(join(tmpdir(), "boxd-turbo-noturbo-"));
    expect(() => requireTurboJson(dir)).toThrow(
      `no turbo.json in ${dir}. boxd-turbo runs Turborepo monorepos. For any other repository, the CI runners guide sets up CI on boxd: https://docs.boxd.sh/use-cases/ci-runners`,
    );
    writeFileSync(join(dir, "turbo.jsonc"), "{}");
    expect(requireTurboJson(dir)).toBe(join(dir, "turbo.jsonc"));
  });
});

describe("githubAccess", () => {
  const server = { machineId: "srv", name: "boxd-turbo-server", cacheUrl: "", token: "" };
  const ask = async (stdout: string) => {
    const scripts: string[] = [];
    const boxd = {
      machines: {
        exec: async (_id: string, p: { command: string[] }) => {
          scripts.push(p.command[2] ?? "");
          return { stdout, stderr: "", exitCode: 0 };
        },
      },
    } as never;
    return { access: await githubAccess(boxd, server, "acme/web"), script: scripts[0] ?? "" };
  };

  test("looks for the repository among the ones the installation lists, with the token on no command line", async () => {
    const { access, script } = await ask("repo:ok\n");
    expect(access).toBe("ok");
    expect(script).toContain("/installation/repositories");
    expect(script).toContain("'acme/web'");
    expect(script).not.toMatch(/curl[^\n]*Bearer/);
  });

  test("a repository the installation does not list cannot be read by it, even when it is public", async () => {
    expect((await ask("repo:missing\n")).access).toBe("no-repo");
    expect((await ask("no-app\n")).access).toBe("no-app");
    expect((await ask("repo:error 502\n")).access).toBe("unknown");
  });
});

describe("matchRun", () => {
  const ids = ["20261030-101503-a1b2c3d", "20261030-111503-d00d2fe", "20261031-090000-d00d2fe"];
  test("a run is found by its id, the start of its id, or its commit's hash, short or full", () => {
    expect(matchRun(ids, "20261030-101503-a1b2c3d")).toBe("20261030-101503-a1b2c3d");
    expect(matchRun(ids, "20261030-1015")).toBe("20261030-101503-a1b2c3d");
    expect(matchRun(ids, "a1b2c3d")).toBe("20261030-101503-a1b2c3d");
    expect(matchRun(ids, "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678")).toBe("20261030-101503-a1b2c3d");
    expect(matchRun(ids, "d00d2fe")).toBe("20261031-090000-d00d2fe");
    expect(matchRun(ids, "ffffff0")).toBeUndefined();
  });
});

describe("local runs and secrets", () => {
  const rec = { secrets: ["NPM_TOKEN"] } as unknown as RepoRecord;
  test("a local run gets the default branch's secrets, and names the working copy's others as left out", () => {
    expect(localSecrets(rec, ["NPM_TOKEN", "PROD_DB_PASSWORD"])).toEqual({
      secrets: ["NPM_TOKEN"],
      ignored: ["PROD_DB_PASSWORD"],
    });
    expect(localSecrets({} as RepoRecord, ["A"])).toEqual({ secrets: [], ignored: ["A"] });
  });
});

describe("writeRegularFile", () => {
  test("replaces a regular file in one step, and refuses to write through a symbolic link", () => {
    const dir = mkdtempSync(join(tmpdir(), "boxd-turbo-write-"));
    const file = join(dir, ".boxd-turbo.json");
    writeRegularFile(file, "{}\n");
    writeRegularFile(file, '{ "org": "acme" }\n');
    expect(readFileSync(file, "utf8")).toBe('{ "org": "acme" }\n');
    const target = join(dir, "victim");
    writeFileSync(target, "precious");
    const link = join(dir, "linked.json");
    symlinkSync(target, link);
    expect(() => writeRegularFile(link, "{}")).toThrow(
      `${link} is not a regular file, so boxd-turbo will not write it`,
    );
    expect(readFileSync(target, "utf8")).toBe("precious");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});

describe("parseRuns", () => {
  test("skips a run file that is not JSON, and removes control characters from what it shows", () => {
    const good = JSON.stringify({
      id: "r1",
      ref: "main",
      error: "bad \u001b]52;c;ZXZpbA==\u0007thing",
      warnings: ["\u001b[31mred\u001b[0m"],
      results: [{ id: "a#te\u001bst", status: "failed" }],
    });
    const runs = parseRuns([good, "{ not json", null]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.error).toBe("bad thing");
    expect(runs[0]?.warnings).toEqual(["red"]);
    expect(runs[0]?.results[0]?.id).toBe("a#test");
  });
});
