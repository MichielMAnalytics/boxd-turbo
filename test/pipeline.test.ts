import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { SnapshotInfo } from "../src/boxd/sdk.js";
import type { RepoRecord } from "../src/boxd/snapshot.js";
import { fsStore, type Store } from "../src/boxd/store.js";
import type { BoxWorker, Pool, PoolOptions } from "../src/boxd/worker.js";
import type { TaskNode } from "../src/core/graph.js";
import type { RunRecord } from "../src/core/record.js";
import type { TaskResult } from "../src/core/scheduler.js";
import { type PipelineDeps, type PipelineEvent, type RunInput, runPipeline } from "../src/pipeline.js";

type Spec = { id: string; deps?: string[]; hit?: boolean };

const planJson = (specs: Spec[], selectors: string[]) =>
  JSON.stringify({
    version: 1,
    turboVersion: "2.11.10",
    selectors: selectors.map((selector) => ({ selector })),
    warnings: ["a warning from the planner"],
    config: { maxMachines: 32, packSeconds: 10 },
    dry: {
      tasks: specs.map((s) => ({
        taskId: s.id,
        task: s.id.split("#")[1],
        package: s.id.split("#")[0],
        directory: `packages/${s.id.split("#")[0]}`,
        hash: s.id,
        cache: { status: s.hit ? "HIT" : "MISS" },
        dependencies: s.deps ?? [],
        outputs: ["dist/**"],
        command: "run",
      })),
    },
  });

const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });

class FakePool implements Pool {
  created = 0;
  live = new Set<string>();
  ran: string[][] = [];
  released: [string, boolean][] = [];
  installs = 0;
  snapshots: string[] = [];
  parked: BoxWorker[] = [];
  fail = new Set<string>();
  depsHash = "aaaaaaaaaaaaaaaa";
  plan = { stdout: planJson([], []), stderr: "", exitCode: 0 };
  options?: PoolOptions;

  async acquire(cpus?: number): Promise<BoxWorker> {
    const p = this.parked.findIndex((w) => w.cpus === (cpus ?? 2));
    if (p >= 0) return this.parked.splice(p, 1)[0] as BoxWorker;
    this.created += 1;
    const id = `w${this.created}`;
    this.live.add(id);
    const pool = this;
    return {
      id,
      machineId: id,
      cpus: cpus ?? 2,
      async run(tasks: TaskNode[]): Promise<TaskResult[]> {
        pool.ran.push(tasks.map((t) => t.id));
        return tasks.map((t) => ({
          id: t.id,
          status: pool.fail.has(t.id) ? "failed" : "ran",
          seconds: 2,
          logTail: `log of ${t.id}`,
          machine: id,
        }));
      },
      async release({ failed }) {
        pool.released.push([id, failed]);
        pool.live.delete(id);
      },
      async sh(script: string) {
        if (script.includes("sha256sum")) return ok(`${pool.depsHash}\n`);
        if (script.includes("boxd-ci-planner.mjs")) return pool.plan;
        if (script.includes("--frozen-lockfile")) {
          pool.installs += 1;
          return ok();
        }
        return ok();
      },
      async upload() {},
    };
  }
  setSnapshot(name: string) {
    this.snapshots.push(name);
  }
  park(w: BoxWorker) {
    this.parked.push(w);
  }
  async drain() {
    this.live.clear();
    this.parked = [];
  }
  machines() {
    return this.created;
  }
  kept() {
    return [];
  }
  machineSeconds() {
    return {};
  }
}

const repo: RepoRecord = {
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
};

const setup = (o: { pool?: FakePool; readySnapshots?: string[] } = {}) => {
  const pool = o.pool ?? new FakePool();
  const store: Store = fsStore(mkdtempSync(join(tmpdir(), "boxd-ci-pipe-")));
  const calls: string[] = [];
  const events: PipelineEvent[] = [];
  const saved: string[] = [];
  const deps: PipelineDeps = {
    boxd: {
      snapshots: {
        create: async (_m: string, name: string) => {
          saved.push(name);
          return { version: 1 };
        },
        get: async (name: string): Promise<SnapshotInfo> => {
          if (saved.includes(name) || o.readySnapshots?.includes(name))
            return { name, version: 1, status: "ready", vcpu: 2 };
          throw new Error("no such snapshot");
        },
      },
    },
    store,
    cache: { url: "https://cache.boxd-ci-server.boxd.sh", token: "t".repeat(48) },
    plannerBundle: new Uint8Array([1]),
    pool: (opts) => {
      pool.options = opts;
      return pool;
    },
    promote: async ({ run }) => {
      calls.push(`promote ${run.sha}`);
    },
    onStart: (r) => {
      calls.push(`start ${r.status}`);
    },
    onFinish: (r) => {
      calls.push(`finish ${r.status}`);
    },
    onEvent: (e) => events.push(e),
  };
  return { pool, store, calls, events, saved, deps };
};

const push = (ref = "main"): RunInput => ({
  repo,
  trigger: "push",
  sha: "d00d2fe",
  ref,
  prepare: { kind: "commit", sha: "d00d2fe" },
});

describe("runPipeline", () => {
  test("a planner that fails ends the run as a failure with its error, and drains the machines", async () => {
    const { pool, store, deps, calls } = setup();
    pool.plan = { stdout: '{"error":"turbo is not installed in this repository"}', stderr: "", exitCode: 1 };
    const r = await runPipeline(deps, push());
    expect(r.status).toBe("failure");
    expect(r.error).toBe("planning failed: turbo is not installed in this repository");
    expect(r.results).toEqual([]);
    expect(pool.live.size).toBe(0);
    expect(calls).toEqual(["start running", "finish failure"]);
    const stored = JSON.parse((await store.read(`runs/acme-web/${r.id}.json`)) ?? "{}") as RunRecord;
    expect(stored.status).toBe("failure");
  });

  test("an all-cached plan starts no machine beyond the planner", async () => {
    const { pool, deps } = setup();
    pool.plan = ok(
      planJson(
        [
          { id: "a#build", hit: true },
          { id: "a#test", deps: ["a#build"], hit: true },
        ],
        ["a#test"],
      ),
    );
    const r = await runPipeline(deps, push("feature"));
    expect(r.status).toBe("success");
    expect(r.results.map((x) => [x.id, x.status])).toEqual([
      ["a#build", "restored"],
      ["a#test", "restored"],
    ]);
    expect(r.machines).toBe(1);
    expect(pool.ran).toEqual([]);
  });

  test("tasks run with the cache settings, the planner's machine runs first, and the record and logs are stored", async () => {
    const { pool, store, deps } = setup();
    pool.plan = ok(
      planJson([{ id: "a#build" }, { id: "a#test", deps: ["a#build"] }, { id: "b#lint" }], ["a#test", "b#lint"]),
    );
    pool.fail.add("b#lint");
    const r = await runPipeline(deps, push("feature"));
    expect(pool.options?.env).toEqual({
      TURBO_API: "https://cache.boxd-ci-server.boxd.sh",
      TURBO_TOKEN: "t".repeat(48),
      TURBO_TEAM: "acme-web",
      TURBO_TELEMETRY_DISABLED: "1",
      TURBO_NO_UPDATE_NOTIFIER: "1",
      CI: "1",
    });
    expect(r.status).toBe("failure");
    expect(r.results.find((x) => x.id === "a#test")).toMatchObject({ status: "ran", logTail: "" });
    expect(r.results.find((x) => x.id === "b#lint")).toMatchObject({ status: "failed", logTail: "log of b#lint" });
    expect(r.results.find((x) => x.id === "a#build")?.machine).toBe("w1");
    expect(r.warnings).toEqual(["a warning from the planner"]);
    const logs = JSON.parse((await store.read(`runs/acme-web/${r.id}.logs.json`)) ?? "{}");
    expect(logs).toEqual({ "a#build": "log of a#build", "a#test": "log of a#test", "b#lint": "log of b#lint" });
    const durations = JSON.parse((await store.read("runs/acme-web/durations.json")) ?? "{}");
    expect(durations).toEqual({ "a#build": 2, "a#test": 2, "b#lint": 2 });
  });

  test("each executed task records when it started, in seconds from the start of the run", async () => {
    const { pool, deps } = setup();
    let t = Date.parse("2026-10-30T10:00:00.000Z");
    deps.now = () => {
      t += 500;
      return new Date(t);
    };
    pool.plan = ok(planJson([{ id: "a#build" }, { id: "a#test", deps: ["a#build"] }], ["a#test"]));
    const r = await runPipeline(deps, push("feature"));
    const at = r.results.map((x) => x.at);
    expect(at.every((x) => typeof x === "number" && x > 0)).toBe(true);
    expect((at[1] as number) > (at[0] as number)).toBe(true);
  });

  test("a group cleans the outputs of its whole dependency closure", async () => {
    const { pool, deps } = setup();
    pool.plan = ok(planJson([{ id: "a#build" }, { id: "b#test", deps: ["a#build"] }], ["b#test"]));
    await runPipeline(deps, push("feature"));
    const node = (id: string, d: string[]) => ({
      id,
      deps: d,
      dir: `packages/${id.split("#")[0]}`,
      outputs: ["dist/**"],
    });
    expect(pool.options?.outputsOf?.([node("b#test", ["a#build"]) as TaskNode])).toEqual([
      { dir: "packages/a", globs: ["dist/**"] },
      { dir: "packages/b", globs: ["dist/**"] },
    ]);
  });

  test("promote runs only after a green push to the default branch has been reported", async () => {
    const plan = ok(planJson([{ id: "a#test" }], ["a#test"]));
    const green = setup();
    green.pool.plan = plan;
    await runPipeline(green.deps, push("main"));
    expect(green.calls).toEqual(["start running", "finish success", "promote d00d2fe"]);

    const branch = setup();
    branch.pool.plan = plan;
    await runPipeline(branch.deps, push("feature"));
    expect(branch.calls).not.toContain("promote d00d2fe");

    const red = setup();
    red.pool.plan = plan;
    red.pool.fail.add("a#test");
    await runPipeline(red.deps, push("main"));
    expect(red.calls).not.toContain("promote d00d2fe");

    const local = setup();
    local.pool.plan = plan;
    await runPipeline(local.deps, { ...push("main"), trigger: "local" });
    expect(local.calls).not.toContain("promote d00d2fe");
  });

  test("changed dependency files install once, on the planner, and the other machines restore that snapshot", async () => {
    const { pool, deps, saved } = setup();
    pool.depsHash = "bbbbbbbbbbbbbbbb";
    pool.plan = ok(planJson([{ id: "a#test" }, { id: "b#test" }], ["a#test", "b#test"]));
    const r = await runPipeline(deps, push("feature"));
    expect(pool.installs).toBe(1);
    expect(saved).toEqual(["bci-acme-web-deps-bbbbbbbbbb"]);
    expect(pool.snapshots).toEqual(["bci-acme-web-deps-bbbbbbbbbb"]);
    expect(r.snapshot).toBe("bci-acme-web-deps-bbbbbbbbbb");
  });

  test("a dependency snapshot that already exists is restored instead of installing", async () => {
    const { pool, deps } = setup({ readySnapshots: ["bci-acme-web-deps-bbbbbbbbbb"] });
    pool.depsHash = "bbbbbbbbbbbbbbbb";
    pool.plan = ok(planJson([{ id: "a#test" }], ["a#test"]));
    await runPipeline(deps, push("feature"));
    expect(pool.installs).toBe(0);
    expect(pool.snapshots).toEqual(["bci-acme-web-deps-bbbbbbbbbb"]);
    expect(pool.released).toContainEqual(["w1", false]);
  });

  test("a cancelled run stops, drains, and is recorded as cancelled", async () => {
    const { pool, deps } = setup();
    const ctl = new AbortController();
    pool.plan = ok(planJson([{ id: "a#test" }], ["a#test"]));
    deps.signal = ctl.signal;
    deps.onEvent = (e) => {
      if (e.type === "phase" && e.message.startsWith("planning")) ctl.abort();
    };
    const r = await runPipeline(deps, push("feature"));
    expect(r.status).toBe("failure");
    expect(r.error).toBe("the run was cancelled");
    expect(pool.live.size).toBe(0);
  });
});
