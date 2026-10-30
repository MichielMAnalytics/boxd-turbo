import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseCli } from "../src/cli/args.js";
import { initPlan } from "../src/cli/commands/init.js";
import { makePatch, parseRemote } from "../src/cli/git.js";
import { ciTaggedTasks, proposeCiTags } from "../src/core/propose.js";

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
    expect(() => parseCli(["deploy"])).toThrow("unknown command deploy: try init, run, ls, logs, grep or doctor");
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
});

describe("makePatch", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=ci@example.com", "-c", "user.name=ci", ...args], { cwd, encoding: "utf8" });

  test("the working copy against a base commit, tracked edits, deletions, new files and binaries included", () => {
    const repo = mkdtempSync(join(tmpdir(), "boxd-ci-patch-"));
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

    const copy = mkdtempSync(join(tmpdir(), "boxd-ci-apply-"));
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
    const repo = mkdtempSync(join(tmpdir(), "boxd-ci-patch-"));
    git(repo, "init", "-q");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    expect(makePatch(repo, git(repo, "rev-parse", "HEAD").trim()).length).toBe(0);
  });
});

describe("proposeCiTags", () => {
  test("a turbo.json with ci tags is left as it is", () => {
    const text = '{ "tasks": { "test": { "tags": ["ci"] } } }';
    expect(proposeCiTags(text)).toEqual({ text, tagged: [] });
  });

  test("tags the usual check tasks that exist, keeping comments and other settings", () => {
    const text = `{
  // build first
  "tasks": {
    "build": { "outputs": ["dist/**"] },
    "lint": {},
    "type-check": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["build"], "tags": ["slow"] }
  }
}`;
    const r = proposeCiTags(text);
    expect(r.tagged).toEqual(["lint", "type-check", "test"]);
    expect(r.text).toContain("// build first");
    const parsed = JSON.parse(r.text.replace(/\/\/.*$/m, ""));
    expect(parsed.tasks.lint.tags).toEqual(["ci"]);
    expect(parsed.tasks["type-check"]).toEqual({ dependsOn: ["^build"], tags: ["ci"] });
    expect(parsed.tasks.test.tags).toEqual(["slow", "ci"]);
    expect(parsed.tasks.build.tags).toBeUndefined();
  });

  test("nothing to tag says so", () => {
    expect(proposeCiTags('{ "tasks": { "build": {} } }').tagged).toEqual([]);
  });
});

describe("ciTaggedTasks", () => {
  test("finds ci tags in the root turbo.json and in package turbo.json files, ignoring !ci", () => {
    expect(
      ciTaggedTasks([
        '{ "tasks": { "build": {} } }',
        '{ "extends": ["//"], "tasks": { "type-check": { "tags": ["ci"] }, "test": { "tags": ["ci:cpus:4"] } } }',
        '{ "extends": ["//"], "tasks": { "lint": { "tags": ["!ci"] } } }',
      ]),
    ).toEqual(["test", "type-check"]);
    expect(ciTaggedTasks(['{ "tasks": { "lint": { "tags": ["!ci"] } } }', "not json"])).toEqual([]);
  });
});

describe("init --dry-run", () => {
  test("lists what init would do, in order, without signing in to boxd", () => {
    const steps = initPlan({
      repo: "acme/web",
      org: "acme",
      server: "boxd-ci-server",
      hasServer: false,
      hasSnapshot: false,
      tagged: ["lint", "test"],
      github: true,
    });
    expect(steps).toEqual([
      "tag lint, test with ci in turbo.json",
      "write .boxd-ci.json (org acme)",
      "start boxd-ci-server in acme: the Turborepo cache and run history",
      "build the first snapshot of acme/web from its default branch",
      "install the push automation on boxd-ci-server and check the boxd GitHub App can read acme/web",
    ]);
  });
});
