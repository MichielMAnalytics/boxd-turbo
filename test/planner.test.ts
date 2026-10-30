import { chmodSync, cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { plan } from "../src/planner/planner.js";

const fixture = fileURLToPath(new URL("./fixtures/mini-turbo", import.meta.url));
const turbo = fileURLToPath(new URL("../node_modules/.bin/turbo", import.meta.url));

/** A stand-in turbo binary: prints this version, and this error for anything else. */
function fakeTurbo(version: string, error = "should not run"): string {
  const dir = mkdtempSync(join(tmpdir(), "boxd-ci-turbo-"));
  const file = join(dir, "turbo");
  writeFileSync(
    file,
    `#!/bin/sh\nif [ "$1" = --version ]; then echo ${version}; exit 0; fi\necho '${error}' >&2\nexit 1\n`,
  );
  chmodSync(file, 0o755);
  return file;
}

describe("plan", () => {
  test("selects the ci-tagged tasks of the fixture and returns Turborepo's graph for them", async () => {
    const p = await plan({ cwd: fixture, turbo });
    expect(p.selectors).toEqual([
      { selector: "//#lint" },
      { selector: "a#lint" },
      { selector: "a#test" },
      { selector: "b#test" },
      { selector: "c#lint", cpus: 4 },
    ]);
    const ids = p.dry.tasks.map((t) => t.taskId).sort();
    expect(ids).toEqual(["//#lint", "a#build", "a#lint", "a#test", "b#build", "b#test", "c#lint"]);
    expect(p.dry.tasks.find((t) => t.taskId === "b#test")?.dependencies).toEqual(["a#build", "b#build"]);
    expect(p.turboVersion).toBe("2.11.10");
  });

  test("a repository without ci tags plans the usual checks it defines, and says so", async () => {
    const p = await plan({ cwd: fixture, turbo, readTurboJson: () => ({ tasks: { test: {}, build: {} } }) });
    // c's own turbo.json defines lint, so lint is one of its checks; its test opts out with !ci.
    expect(p.selectors).toEqual([{ selector: "a#test" }, { selector: "b#test" }, { selector: "c#lint", cpus: 4 }]);
    expect(p.dry.tasks.map((t) => t.taskId).sort()).toEqual(["a#build", "a#test", "b#build", "b#test", "c#lint"]);
    expect(p.warnings).toContain("no task in turbo.json is tagged ci, so boxd CI runs the usual checks: test, lint");
    expect(p.nothingToRun).toBeUndefined();
  });

  test("a repository with nothing to run plans nothing and says why", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boxd-ci-plan-"));
    cpSync(fixture, dir, { recursive: true });
    writeFileSync(join(dir, "packages/c/turbo.json"), '{ "extends": ["//"] }');
    const p = await plan({ cwd: dir, turbo, readTurboJson: () => ({ tasks: { build: {} } }) });
    expect(p.selectors).toEqual([]);
    expect(p.dry.tasks).toEqual([]);
    expect(p.nothingToRun).toMatch(/^nothing to run\. No task in turbo\.json is tagged ci/);
  });

  test("a turbo older than 2.4 is refused, naming the version it found", async () => {
    await expect(plan({ cwd: fixture, turbo: fakeTurbo("2.3.4") })).rejects.toThrow(
      "boxd CI needs turbo 2.4 or newer, and this repository has 2.3.4. Upgrade the turbo devDependency.",
    );
  });

  test("ci tags on a turbo older than 2.11 get an error that says what to do", async () => {
    const old = fakeTurbo("2.5.8", "x Found an unknown key `tags`.");
    await expect(plan({ cwd: fixture, turbo: old })).rejects.toThrow(
      "turbo.json has ci tags, which need turbo 2.11 or newer, and this repository has 2.5.8. Upgrade the turbo devDependency, or remove the tags to run the usual checks.",
    );
  });

  test("a missing turbo binary is an error that says how to fix it", async () => {
    await expect(plan({ cwd: fixture, turbo: "/nonexistent/turbo" })).rejects.toThrow(
      "turbo is not installed in this repository. Add it as a devDependency.",
    );
  });

  test("reads .boxd-ci.json at the planned commit, and passes its warnings on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boxd-ci-plan-"));
    cpSync(fixture, dir, { recursive: true });
    writeFileSync(join(dir, ".boxd-ci.json"), '{ "maxMachines": 8, "colour": "blue" }');
    const p = await plan({ cwd: dir, turbo });
    expect(p.config).toEqual({ maxMachines: 8, packSeconds: 10 });
    expect(p.warnings).toContain(".boxd-ci.json: unknown setting colour");
  });

  test("without .boxd-ci.json the plan carries the defaults", async () => {
    expect((await plan({ cwd: fixture, turbo })).config).toEqual({ maxMachines: 32, packSeconds: 10 });
  });
});
