import { describe, expect, test } from "vitest";
import { buildGraph, type TaskNode, type TurboDryRun } from "../src/core/graph.js";
import { pack } from "../src/core/pack.js";
import { schedule, type TaskResult, type Worker, type WorkerPool } from "../src/core/scheduler.js";

const t = (taskId: string, deps: string[] = [], status: "HIT" | "MISS" = "MISS"): TurboDryRun["tasks"][number] => {
  const [pkg = "", task = ""] = taskId.split("#");
  return {
    taskId,
    task,
    package: pkg,
    directory: `packages/${pkg}`,
    hash: taskId,
    cache: { status },
    dependencies: deps,
    outputs: [],
    command: "x",
  };
};
const graph = (tasks: TurboDryRun["tasks"], selected: string[], cpus: Record<string, number> = {}) =>
  buildGraph(
    { tasks },
    selected.map((selector) => (cpus[selector] ? { selector, cpus: cpus[selector] } : { selector })),
  );

/** A pool whose workers finish each task on the next tick, failing the ones in `fail`. */
class FakePool implements WorkerPool {
  acquired = 0;
  live = 0;
  maxLive = 0;
  runs: string[][] = [];
  released: { id: string; failed: boolean }[] = [];
  constructor(
    private fail: string[] = [],
    private acquireError?: Error,
  ) {}
  async acquire(_cpus?: number): Promise<Worker> {
    if (this.acquireError) throw this.acquireError;
    this.acquired++;
    this.live++;
    this.maxLive = Math.max(this.maxLive, this.live);
    const id = `w${this.acquired}`;
    return {
      id,
      run: async (tasks: TaskNode[]): Promise<TaskResult[]> => {
        this.runs.push(tasks.map((x) => x.id));
        await new Promise((r) => setTimeout(r, 1));
        return tasks.map((x) => ({
          id: x.id,
          status: this.fail.includes(x.id) ? "failed" : "ran",
          seconds: 1,
          logTail: "",
          machine: id,
        }));
      },
      release: async ({ failed }) => {
        this.live--;
        this.released.push({ id, failed });
      },
    };
  }
}

const opts = { maxWorkers: 4, packSeconds: 0, durations: {} };
const byId = (results: TaskResult[]) => Object.fromEntries(results.map((r) => [r.id, r.status]));

describe("schedule", () => {
  test("runs a task only after its dependencies", async () => {
    const pool = new FakePool();
    await schedule(graph([t("a#build"), t("b#build", ["a#build"]), t("b#test", ["b#build"])], ["b#test"]), pool, opts);
    expect(pool.runs.flat()).toEqual(["a#build", "b#build", "b#test"]);
  });

  test("never holds more than maxWorkers machines at once", async () => {
    const pool = new FakePool();
    const tasks = Array.from({ length: 10 }, (_, i) => t(`p${i}#test`));
    const results = await schedule(
      graph(
        tasks,
        tasks.map((x) => x.taskId),
      ),
      pool,
      { ...opts, maxWorkers: 3 },
    );
    expect(pool.maxLive).toBe(3);
    expect(results.filter((r) => r.status === "ran")).toHaveLength(10);
  });

  test("a failed task skips everything that depends on it, and the run still finishes", async () => {
    const pool = new FakePool(["a#build"]);
    const results = await schedule(
      graph([t("a#build"), t("b#build", ["a#build"]), t("b#test", ["b#build"]), t("c#test")], ["b#test", "c#test"]),
      pool,
      opts,
    );
    expect(byId(results)).toEqual({ "a#build": "failed", "b#build": "skipped", "b#test": "skipped", "c#test": "ran" });
    expect(results.find((r) => r.id === "b#test")?.logTail).toBe("skipped: a#build failed");
  });

  test("an idle machine takes the next ready task instead of a new one", async () => {
    const pool = new FakePool();
    await schedule(graph([t("a#build"), t("b#build", ["a#build"]), t("b#test", ["b#build"])], ["b#test"]), pool, opts);
    expect(pool.acquired).toBe(1);
  });

  test("every machine is released at the end, a failed task's machine as failed", async () => {
    const pool = new FakePool(["a#test"]);
    await schedule(graph([t("a#test"), t("b#test")], ["a#test", "b#test"]), pool, { ...opts, maxWorkers: 2 });
    expect(pool.live).toBe(0);
    expect(pool.released.filter((r) => r.failed)).toHaveLength(1);
  });

  test("an all-cached graph starts no machine and reports every task restored", async () => {
    const pool = new FakePool();
    const results = await schedule(
      graph([t("a#build", [], "HIT"), t("a#test", ["a#build"], "HIT")], ["a#test"]),
      pool,
      opts,
    );
    expect(pool.acquired).toBe(0);
    expect(byId(results)).toEqual({ "a#build": "restored", "a#test": "restored" });
  });

  test("tasks whose package has no script are left out of the results", async () => {
    const tasks = [t("a#build"), { ...t("a#test", ["a#build"]), command: "<NONEXISTENT>" }];
    const results = await schedule(graph(tasks, ["a#test"]), new FakePool(), opts);
    expect(byId(results)).toEqual({ "a#build": "ran" });
  });

  test("aborting releases every machine and rejects", async () => {
    const pool = new FakePool();
    const ac = new AbortController();
    const tasks = Array.from({ length: 6 }, (_, i) => t(`p${i}#test`));
    const run = schedule(
      graph(
        tasks,
        tasks.map((x) => x.taskId),
      ),
      pool,
      { ...opts, signal: ac.signal },
    );
    ac.abort();
    await expect(run).rejects.toThrow("aborted");
    expect(pool.live).toBe(0);
  });

  test("a machine that cannot be had fails its tasks and skips their dependents", async () => {
    const pool = new FakePool([], new Error("machine limit reached"));
    const results = await schedule(graph([t("a#build"), t("a#test", ["a#build"])], ["a#test"]), pool, opts);
    expect(byId(results)).toEqual({ "a#build": "failed", "a#test": "skipped" });
    expect(results.find((r) => r.id === "a#build")?.logTail).toContain("machine limit reached");
  });

  test("tasks that ask for different CPUs never share a machine", async () => {
    const pool = new FakePool();
    await schedule(graph([t("a#build"), t("b#test", ["a#build"])], ["a#build", "b#test"], { "b#test": 8 }), pool, opts);
    expect(pool.acquired).toBe(2);
  });

  test("an idle machine of the wrong size gives up its slot when the cap is reached", async () => {
    const pool = new FakePool();
    const results = await schedule(graph([t("a#build"), t("b#test", ["a#build"])], ["b#test"], { "b#test": 8 }), pool, {
      ...opts,
      maxWorkers: 1,
    });
    expect(byId(results)).toEqual({ "a#build": "ran", "b#test": "ran" });
    expect(pool.maxLive).toBe(1);
  });

  test("ready tasks start in priority order", async () => {
    const pool = new FakePool();
    await schedule(
      graph([t("short#test"), t("long#build"), t("long#test", ["long#build"])], ["short#test", "long#test"]),
      pool,
      {
        ...opts,
        maxWorkers: 1,
        durations: { "short#test": 5, "long#build": 60, "long#test": 60 },
      },
    );
    expect(pool.runs[0]).toEqual(["long#build"]);
  });
});

describe("pack", () => {
  const node = (id: string, cpus?: number) =>
    ({
      id,
      pkg: id,
      task: "test",
      dir: "",
      hash: id,
      deps: [],
      outputs: [],
      cached: false,
      noop: false,
      ...(cpus ? { cpus } : {}),
    }) as TaskNode;

  test("short tasks share a machine until their total reaches packSeconds", () => {
    const groups = pack([node("a"), node("b"), node("c"), node("d")], { a: 4, b: 4, c: 4, d: 4 }, 10);
    expect(groups.map((g) => g.map((n) => n.id))).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("a task with no known duration, or a long one, gets its own machine", () => {
    const groups = pack([node("a"), node("long"), node("new")], { a: 2, long: 300 }, 10);
    expect(groups.map((g) => g.map((n) => n.id))).toEqual([["a"], ["long"], ["new"]]);
  });

  test("tasks with different CPUs are never packed together", () => {
    const groups = pack([node("a"), node("b", 4)], { a: 1, b: 1 }, 10);
    expect(groups.map((g) => g.map((n) => n.id))).toEqual([["a"], ["b"]]);
  });

  test("packSeconds 0 gives every task its own machine", () => {
    expect(pack([node("a"), node("b")], { a: 1, b: 1 }, 0)).toHaveLength(2);
  });
});
