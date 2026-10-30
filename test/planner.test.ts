import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { plan } from "../src/planner/planner.js";

const fixture = fileURLToPath(new URL("./fixtures/mini-turbo", import.meta.url));
const turbo = fileURLToPath(new URL("../node_modules/.bin/turbo", import.meta.url));

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

  test("a repository without ci tags plans nothing and says why", async () => {
    const p = await plan({ cwd: fixture, turbo, readTurboJson: () => ({ tasks: { test: {} } }) });
    expect(p.selectors).toEqual([]);
    expect(p.dry.tasks).toEqual([]);
    expect(p.warnings).toContain("no task is tagged ci in turbo.json, so there is nothing to run");
  });

  test("a missing turbo binary is an error that says how to fix it", async () => {
    await expect(plan({ cwd: fixture, turbo: "/nonexistent/turbo" })).rejects.toThrow(
      "turbo is not installed in this repository: add it as a devDependency",
    );
  });
});
