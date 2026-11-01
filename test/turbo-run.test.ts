// The worker's shell and parser against a real Turborepo run on the fixture: what a task machine
// does, minus the machine.

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import { cleanOutputsScript, parseRunOutput, turboRunScript } from "../src/boxd/scripts.js";
import { buildGraph, type TaskGraph } from "../src/core/graph.js";
import { plan } from "../src/planner/planner.js";

const fixture = fileURLToPath(new URL("./fixtures/mini-turbo", import.meta.url));
const turbo = fileURLToPath(new URL("../node_modules/.bin/turbo", import.meta.url));
const env = { ...process.env, CI: "1", TURBO_TELEMETRY_DISABLED: "1", TURBO_NO_UPDATE_NOTIFIER: "1" };

let repo: string;
let graph: TaskGraph;

/** One group on the "machine": clean the outputs, run Turborepo, parse what comes back. */
const runGroup = (ids: string[]) => {
  const tasks = ids.map((id) => graph.nodes.get(id) ?? expect.fail(`no node ${id}`));
  const script = `${cleanOutputsScript(
    repo,
    tasks.map((t) => ({ dir: t.dir, globs: t.outputs })),
  )}; ${turboRunScript(repo, tasks)}`;
  const out = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
  return parseRunOutput(`${out.stderr}\n${out.stdout}`, tasks, "local");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "boxd-turbo-turbo-"));
  cpSync(fixture, repo, { recursive: true });
  // a#lint fails, so a group holds a failure next to a success.
  const a = JSON.parse(readFileSync(join(repo, "packages/a/package.json"), "utf8"));
  a.scripts.lint = "echo boom-a && exit 3";
  writeFileSync(join(repo, "packages/a/package.json"), JSON.stringify(a));
  mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
  symlinkSync(turbo, join(repo, "node_modules/.bin/turbo"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=ci@example.com", "-c", "user.name=ci", "commit", "-qm", "fixture");
  const p = await plan({ cwd: repo, turbo, env });
  graph = buildGraph(p.dry, [{ selector: "b#test" }, { selector: "a#lint" }, { selector: "c#lint" }]);
}, 60_000);

describe("a task group on a real Turborepo", () => {
  test("the plan carries each task's log file", () => {
    expect(graph.nodes.get("b#test")?.logFile).toBe("packages/b/.turbo/turbo-test.log");
  });

  test("tasks that pass ran, a task that fails failed with its own output, and the others still run", () => {
    const r = runGroup(["a#lint", "c#lint"]);
    expect(r.map((x) => [x.id, x.status])).toEqual([
      ["a#lint", "failed"],
      ["c#lint", "ran"],
    ]);
    expect(r[0]?.logTail).toContain("boom-a");
    expect(r[1]?.logTail).toContain("lint-c");
    expect(r[1]?.seconds).toBeGreaterThan(0);
  });

  test("a task whose dependencies run in the same Turborepo run passes", () => {
    const r = runGroup(["b#test"]);
    expect(r.map((x) => [x.id, x.status])).toEqual([["b#test", "ran"]]);
  });

  // Cleaning runs on task machines, which have Node 22 or newer (fs.globSync).
  test.skipIf(!("globSync" in fs))(
    "a second run cleans the outputs, restores them from the cache, and drops stale files",
    () => {
      writeFileSync(join(repo, "packages/b/dist/stale.txt"), "left behind by the snapshot");
      const r = runGroup(["b#build", "b#test"]);
      expect(r.map((x) => [x.id, x.status])).toEqual([
        ["b#build", "restored"],
        ["b#test", "restored"],
      ]);
      expect(existsSync(join(repo, "packages/b/dist/b.txt"))).toBe(true);
      expect(existsSync(join(repo, "packages/b/dist/stale.txt"))).toBe(false);
    },
  );
});
