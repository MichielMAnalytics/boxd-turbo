import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildGraph, priorities, type TurboDryRun, toRun } from "../src/core/graph.js";

const task = (
  taskId: string,
  dependencies: string[] | null,
  status: "HIT" | "MISS" = "MISS",
  command = "run",
): TurboDryRun["tasks"][number] => {
  const [pkg, name] = taskId.includes("#") ? (taskId.split("#") as [string, string]) : ["//", taskId];
  return {
    taskId,
    task: name,
    package: pkg,
    directory: pkg === "//" ? "" : `packages/${pkg}`,
    hash: `h-${taskId}`,
    cache: { status },
    dependencies,
    outputs: ["dist/**"],
    command,
  };
};

const dry = (...tasks: TurboDryRun["tasks"]): TurboDryRun => ({ tasks });
const sel = (...s: string[]) => s.map((selector) => ({ selector }));

describe("buildGraph", () => {
  test("includes the selected tasks and their dependency closure, nothing else", () => {
    const g = buildGraph(
      dry(task("a#build", []), task("b#build", ["a#build"]), task("b#test", ["b#build"]), task("c#test", [])),
      sel("b#test"),
    );
    expect([...g.nodes.keys()].sort()).toEqual(["a#build", "b#build", "b#test"]);
    expect([...g.selected]).toEqual(["b#test"]);
    expect(g.nodes.get("b#test")).toMatchObject({ pkg: "b", task: "test", dir: "packages/b", deps: ["b#build"] });
  });

  test("a cache hit is cached, a missing script is a no-op", () => {
    const g = buildGraph(
      dry(task("a#build", [], "HIT"), task("a#test", ["a#build"], "MISS", "<NONEXISTENT>")),
      sel("a#test"),
    );
    expect(g.nodes.get("a#build")).toMatchObject({ cached: true, noop: false });
    expect(g.nodes.get("a#test")).toMatchObject({ cached: false, noop: true });
  });

  test("null dependencies count as none", () => {
    const g = buildGraph(dry(task("a#build", null)), sel("a#build"));
    expect(g.nodes.get("a#build")?.deps).toEqual([]);
  });

  test("the selector's cpus land on its node", () => {
    const g = buildGraph(dry(task("a#test", [])), [{ selector: "a#test", cpus: 4 }]);
    expect(g.nodes.get("a#test")?.cpus).toBe(4);
  });

  test("a single-package repo matches plain selectors to //# task ids", () => {
    const g = buildGraph(dry(task("//#lint", [])), sel("lint"));
    expect([...g.selected]).toEqual(["//#lint"]);
  });

  test("a selector missing from the dry run is an error that names it", () => {
    expect(() => buildGraph(dry(task("a#build", [])), sel("a#test", "b#lint"))).toThrow(
      "Turborepo has no task a#test, b#lint",
    );
  });

  test("a dependency cycle is an error that shows the cycle", () => {
    expect(() => buildGraph(dry(task("a#x", ["b#x"]), task("b#x", ["a#x"])), sel("a#x"))).toThrow(
      "dependency cycle: a#x -> b#x -> a#x",
    );
  });
});

describe("toRun", () => {
  test("lists the uncached real tasks in dependency order", () => {
    const g = buildGraph(
      dry(task("a#build", [], "HIT"), task("b#build", ["a#build"]), task("b#test", ["b#build"]), task("c#test", [])),
      sel("b#test", "c#test"),
    );
    const ids = toRun(g).map((n) => n.id);
    expect(ids.sort()).toEqual(["b#build", "b#test", "c#test"]);
    expect(toRun(g).findIndex((n) => n.id === "b#build")).toBeLessThan(toRun(g).findIndex((n) => n.id === "b#test"));
  });

  test("an all-cached graph has nothing to run", () => {
    const g = buildGraph(dry(task("a#build", [], "HIT"), task("a#test", ["a#build"], "HIT")), sel("a#test"));
    expect(toRun(g)).toEqual([]);
  });

  test("vercel/ai: 254 tasks, every real one restored from the remote cache", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/vercel-ai-dry.json", import.meta.url), "utf8"));
    const selectors = fixture.tasks
      .filter((t: { task: string }) => t.task !== "build")
      .map((t: { taskId: string }) => ({ selector: t.taskId }));
    const g = buildGraph(fixture, selectors);
    expect(g.nodes.size).toBe(254);
    expect(g.selected.size).toBe(168);
    expect(toRun(g)).toEqual([]);
  });
});

describe("priorities", () => {
  test("a task's priority is the longest chain of work it unblocks, itself included", () => {
    const g = buildGraph(
      dry(task("a#build", []), task("b#build", ["a#build"]), task("b#test", ["b#build"]), task("c#test", [])),
      sel("b#test", "c#test"),
    );
    const p = priorities(g, { "a#build": 10, "b#build": 20, "b#test": 30, "c#test": 5 });
    expect(p.get("a#build")).toBe(60);
    expect(p.get("b#build")).toBe(50);
    expect(p.get("c#test")).toBe(5);
  });

  test("unknown durations count as one second", () => {
    const g = buildGraph(dry(task("a#build", []), task("a#test", ["a#build"])), sel("a#test"));
    expect(priorities(g, {}).get("a#build")).toBe(2);
  });
});
