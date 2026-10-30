import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  applyPatchScript,
  checkoutScript,
  cleanOutputsScript,
  fetchScript,
  LOG_MARK,
  parseRunOutput,
  SUMMARY_MARK,
  turboRunScript,
} from "../src/boxd/scripts.js";
import type { TaskNode } from "../src/core/graph.js";

const node = (id: string, logFile = `packages/${id.split("#")[0]}/.turbo/turbo-x.log`): TaskNode => ({
  id,
  pkg: id.split("#")[0] ?? "",
  task: id.split("#")[1] ?? "",
  dir: `packages/${id.split("#")[0]}`,
  hash: id,
  deps: [],
  outputs: [],
  cached: false,
  noop: false,
  logFile,
});

describe("fetchScript", () => {
  test("fetches and checks out the commit, with the token only as an auth header for github.com", () => {
    const s = fetchScript("/home/boxd/work/app", "abc1234");
    expect(s).toContain("cd '/home/boxd/work/app'");
    expect(s).toContain("fetch -q origin abc1234");
    expect(s).toContain("checkout -q -f abc1234");
    expect(s).toContain('"$BOXD_CI_FETCH_TOKEN"');
    // From the environment, so the header is in no process's arguments, and for github.com only,
    // so a submodule elsewhere never sees it.
    expect(s).toContain("GIT_CONFIG_KEY_0=http.https://github.com/.extraheader");
    expect(s).not.toContain("git -c http.extraheader");
    expect(s).not.toMatch(/ghs_|x-access-token:[a-z0-9]/);
  });

  test("on a real repository: checks out the commit with its submodules, and runs no hook the repository planted", () => {
    const root = mkdtempSync(join(tmpdir(), "boxd-ci-fetch-"));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "protocol.file.allow=always", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd,
        stdio: "pipe",
      })
        .toString()
        .trim();
    const sub = join(root, "sub");
    const main = join(root, "main");
    for (const d of [sub, main]) {
      mkdirSync(d);
      git(d, "init", "-q", "-b", "main");
    }
    writeFileSync(join(sub, "sub.txt"), "from the submodule");
    git(sub, "add", ".");
    git(sub, "commit", "-q", "-m", "sub");
    writeFileSync(join(main, "a.txt"), "one");
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "one");
    const work = join(root, "work");
    git(root, "clone", "-q", main, work);
    git(main, "submodule", "add", "-q", sub, "packages/sub");
    git(main, "commit", "-q", "-m", "two");
    const sha = git(main, "rev-parse", "HEAD");
    // What a task on an earlier run could have left in the snapshot.
    writeFileSync(join(work, ".git/hooks/post-checkout"), `#!/bin/sh\ntouch ${join(root, "hook-ran")}\n`);
    chmodSync(join(work, ".git/hooks/post-checkout"), 0o755);
    execFileSync("bash", ["-c", fetchScript(work, sha)], {
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "protocol.file.allow",
        GIT_CONFIG_VALUE_0: "always",
      },
      stdio: "pipe",
    });
    expect(readFileSync(join(work, "packages/sub/sub.txt"), "utf8")).toBe("from the submodule");
    expect(existsSync(join(root, "hook-ran"))).toBe(false);
  });
});

describe("checkoutScript", () => {
  test("checks out a commit the machine already has: no fetch, no token, no hooks", () => {
    const s = checkoutScript("/w", "abc1234");
    expect(s).toContain("checkout -q -f abc1234");
    expect(s).toContain("core.hooksPath=/dev/null");
    expect(s).not.toContain("fetch");
    expect(s).not.toContain("BOXD_CI_FETCH_TOKEN");
    expect(() => checkoutScript("/w", "$(id)")).toThrow("not a commit hash");
  });
});

describe("commits in scripts", () => {
  test("anything but a hex commit hash is refused before it reaches a shell", () => {
    for (const bad of ["main", "abc; rm -rf /", "$(id)", "", "abc123 def"]) {
      expect(() => fetchScript("/w", bad)).toThrow(`not a commit hash: ${bad}`);
      expect(() => applyPatchScript("/w", bad, "/tmp/p")).toThrow(`not a commit hash: ${bad}`);
    }
    expect(() => fetchScript("/w", "0123abc")).not.toThrow();
  });
});

describe("applyPatchScript", () => {
  test("resets to the base commit and applies the patch", () => {
    const s = applyPatchScript("/w", "ba5e123", "/tmp/p.patch");
    expect(s).toContain("checkout -q -f ba5e123");
    expect(s).toContain("git apply --binary --whitespace=nowarn '/tmp/p.patch'");
  });

  test("fetches a base commit the snapshot does not have, and keeps untracked files an install made", () => {
    const s = applyPatchScript("/w", "ba5e123", "/tmp/p.patch");
    expect(s).toContain(
      "git cat-file -e ba5e123^{commit} 2>/dev/null || git -c core.hooksPath=/dev/null fetch -q origin ba5e123",
    );
    expect(s).not.toContain("git clean");
  });
});

describe("cleanOutputsScript", () => {
  test("deletes the declared outputs, keeps negated globs and node_modules", () => {
    const repo = mkdtempSync(join(tmpdir(), "boxd-ci-clean-"));
    const make = (p: string) => {
      mkdirSync(join(repo, p, ".."), { recursive: true });
      writeFileSync(join(repo, p), "x");
    };
    make("packages/a/dist/index.js");
    make("packages/a/dist/types/index.d.ts");
    make("packages/a/src/index.ts");
    make("packages/a/node_modules/dep/dist/keep.js");
    make("packages/b/.next/cache/keep");
    make("packages/b/.next/server/page.js");
    const s = cleanOutputsScript(repo, [
      { dir: "packages/a", globs: ["**/dist/**"] },
      { dir: "packages/b", globs: [".next/**", "!.next/cache/**"] },
    ]);
    execFileSync("bash", ["-c", s]);
    expect(existsSync(join(repo, "packages/a/dist/index.js"))).toBe(false);
    expect(existsSync(join(repo, "packages/a/dist/types/index.d.ts"))).toBe(false);
    expect(existsSync(join(repo, "packages/a/src/index.ts"))).toBe(true);
    expect(existsSync(join(repo, "packages/a/node_modules/dep/dist/keep.js"))).toBe(true);
    expect(existsSync(join(repo, "packages/b/.next/cache/keep"))).toBe(true);
    expect(existsSync(join(repo, "packages/b/.next/server/page.js"))).toBe(false);
  });

  test("no outputs is a no-op script", () => {
    expect(cleanOutputsScript("/w", [])).toBe("true");
  });
});

describe("turboRunScript", () => {
  test("runs exactly the selected tasks with the cache, then prints the summary and each log", () => {
    const s = turboRunScript("/w", [node("a#test"), node("b#lint")]);
    expect(s).toContain(
      "./node_modules/.bin/turbo run 'a#test' 'b#lint' --summarize --cache=local:rw,remote:rw --continue=dependencies-successful",
    );
    expect(s).toContain(SUMMARY_MARK);
    expect(s).toContain(`${LOG_MARK}a#test`);
    expect(s).toContain("'packages/a/.turbo/turbo-x.log'");
  });
});

describe("parseRunOutput", () => {
  const summary = (tasks: object[]) => `${SUMMARY_MARK}\n${JSON.stringify({ tasks })}\n`;
  const exec = (exitCode: number, ms = 4000) => ({ startTime: 1000, endTime: 1000 + ms, exitCode });

  test("an exit code of 0 is ran, anything else failed, with each task's own log tail", () => {
    const out =
      "turbo output\n" +
      summary([
        { taskId: "a#test", cache: { status: "MISS" }, execution: exec(0, 4000) },
        { taskId: "b#test", cache: { status: "MISS" }, execution: exec(1, 2500) },
        { taskId: "a#build", cache: { status: "HIT" }, execution: exec(0, 10) },
      ]) +
      `${LOG_MARK}a#test\nall good\n${LOG_MARK}b#test\nboom\nExpected 1\n`;
    const r = parseRunOutput(out, [node("a#test"), node("b#test")], "bci-1");
    expect(r).toEqual([
      { id: "a#test", status: "ran", seconds: 4, logTail: "all good", machine: "bci-1" },
      { id: "b#test", status: "failed", seconds: 2.5, logTail: "boom\nExpected 1", machine: "bci-1" },
    ]);
  });

  test("log tails come without terminal color codes", () => {
    const out = `${summary([{ taskId: "a#test", cache: { status: "MISS" }, execution: exec(1) }])}${LOG_MARK}a#test\n\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\n`;
    expect(parseRunOutput(out, [node("a#test")], "m")[0]?.logTail).toBe("Test Files  1 failed");
  });

  test("a task Turborepo restored from the cache meanwhile is restored", () => {
    const out = summary([{ taskId: "a#test", cache: { status: "HIT" }, execution: exec(0, 30) }]);
    expect(parseRunOutput(out, [node("a#test")], "m")[0]?.status).toBe("restored");
  });

  test("a task missing from the summary failed, with the end of turbo's output as its log", () => {
    const out = `Error: something broke before the summary\n${summary([])}`;
    const r = parseRunOutput(out, [node("a#test")], "m");
    expect(r[0]).toMatchObject({ status: "failed" });
    expect(r[0]?.logTail).toContain("something broke before the summary");
  });

  test("output without a summary fails every task with turbo's output", () => {
    const r = parseRunOutput("x  turbo: command not found", [node("a#test"), node("b#test")], "m");
    expect(r.map((x) => x.status)).toEqual(["failed", "failed"]);
    expect(r[0]?.logTail).toContain("command not found");
  });
});
