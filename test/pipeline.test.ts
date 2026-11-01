import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { SnapshotInfo } from "../src/boxd/sdk.js";
import { DEPS_HASH_MARK, type RepoRecord } from "../src/boxd/snapshot.js";
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
/** A plan with other settings, selectors or warnings than planJson's. */
const planWith = (specs: Spec[], over: Record<string, unknown>) =>
  JSON.stringify({ ...JSON.parse(planJson(specs, [])), ...over });

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
  snapshotOpts: [string, unknown][] = [];
  keptNames: string[] = [];

  async acquire(cpus?: number): Promise<BoxWorker> {
    this.acquired.push(cpus);
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
        if (script.includes(DEPS_HASH_MARK))
          return pool.hashFails
            ? { stdout: "", stderr: "git: not a repository", exitCode: 128 }
            : ok(`${pool.depsHash}\n`);
        if (script.includes("boxd-turbo-planner.mjs")) return pool.plan;
        if (script.includes("--frozen-lockfile")) {
          pool.installs += 1;
          return ok();
        }
        return ok();
      },
      async upload() {},
    };
  }
  acquired: (number | undefined)[] = [];
  hashFails = false;
  setSnapshot(name: string, o?: { checkedOut?: boolean }) {
    this.snapshots.push(name);
    this.snapshotOpts.push([name, o]);
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
    return this.keptNames;
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
  snapshot: "bt-acme-web-c0ffee1",
  commit: "c0ffee1",
  depsHash: "aaaaaaaaaaaaaaaa",
  cpus: 2,
  builtAt: "2026-10-30T00:00:00.000Z",
};

const setup = (o: { pool?: FakePool; readySnapshots?: string[]; listed?: SnapshotInfo[] } = {}) => {
  const pool = o.pool ?? new FakePool();
  const store: Store = fsStore(mkdtempSync(join(tmpdir(), "boxd-turbo-pipe-")));
  const calls: string[] = [];
  const events: PipelineEvent[] = [];
  const saved: string[] = [];
  const deleted: string[] = [];
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
        list: async () => o.listed ?? [],
        delete: async (name: string) => {
          deleted.push(name);
        },
      },
    },
    store,
    cache: { url: "https://cache.boxd-turbo-server.boxd.sh", token: "t".repeat(48) },
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
  return { pool, store, calls, events, saved, deleted, deps };
};

const push = (ref = "main"): RunInput => ({
  repo,
  trigger: "push",
  sha: "d00d2fe",
  ref,
  prepare: { kind: "commit", sha: "d00d2fe" },
});

describe("runPipeline and what a plan may ask for", () => {
  const big = (over: Record<string, unknown>) =>
    ok(planWith([{ id: "a#test" }], { selectors: [{ selector: "a#test", cpus: 64 }], ...over }));

  test("machine sizes stay within boxd's, and the budget within 1 to 256, whatever the plan says", async () => {
    const { pool, deps, events } = setup();
    pool.plan = big({ config: { maxMachines: 5000, packSeconds: 10 } });
    await runPipeline(deps, push("main"));
    expect(pool.acquired.filter((c) => c !== undefined && c !== 2)).toEqual([8]);
    expect(events.find((e) => e.type === "plan")).toMatchObject({ maxMachines: 256 });
  });

  test("a branch gets the default branch's machine budget at most", async () => {
    const one = setup();
    one.pool.plan = big({ config: { maxMachines: 200, packSeconds: 10 } });
    await runPipeline(one.deps, push("feature"));
    expect(one.events.find((e) => e.type === "plan")).toMatchObject({ maxMachines: 32 });

    const two = setup();
    two.pool.plan = big({ config: { maxMachines: 200, packSeconds: 10 } });
    await runPipeline(two.deps, { ...push("feature"), repo: { ...repo, maxMachines: 64 } });
    expect(two.events.find((e) => e.type === "plan")).toMatchObject({ maxMachines: 64 });
  });
});

describe("runPipeline", () => {
  test("control characters in an error, a warning or a task id never reach the stored run", async () => {
    const { pool, deps } = setup();
    pool.plan = ok(
      planWith([{ id: "a#te\u001b]52;c;ZXZpbA==\u0007st" }], {
        selectors: [{ selector: "a#te\u001b]52;c;ZXZpbA==\u0007st" }],
        warnings: ["a \u001b[31mred\u001b[0m warning"],
      }),
    );
    pool.fail.add("a#te\u001b]52;c;ZXZpbA==\u0007st");
    const r = await runPipeline(deps, push("feature"));
    const stored = JSON.stringify(r);
    expect(stored.includes("\\u001b") || stored.includes("\u001b")).toBe(false);
    expect(r.warnings).toEqual(["a red warning"]);
    expect(r.results[0]?.id).toBe("a#test");

    const failing = setup();
    const link = "bad \u001b]8;;https://x\u001b\\link\u001b]8;;\u001b\\";
    failing.pool.plan = { stdout: JSON.stringify({ error: link }), stderr: "", exitCode: 1 };
    const f = await runPipeline(failing.deps, push("feature"));
    expect(f.error).toBe("planning failed: bad link");
  });

  test("dependency files that cannot be hashed are a warning, not a silent skip", async () => {
    const { pool, deps } = setup();
    pool.hashFails = true;
    pool.plan = ok(planJson([{ id: "a#test", hit: true }], ["a#test"]));
    const r = await runPipeline(deps, push("feature"));
    expect(r.warnings).toContain(
      "could not hash the dependency files (git: not a repository), so the run uses the snapshot's dependencies",
    );
  });

  test("a cancelled run records why, and is marked cancelled", async () => {
    const { pool, deps } = setup();
    const ctl = new AbortController();
    pool.plan = ok(planJson([{ id: "a#test" }], ["a#test"]));
    deps.signal = ctl.signal;
    deps.onEvent = (e) => {
      if (e.type === "phase" && e.message.startsWith("planning")) ctl.abort(new Error("superseded by d00d2fe"));
    };
    const r = await runPipeline(deps, push("feature"));
    expect(r).toMatchObject({ status: "failure", cancelled: true, error: "superseded by d00d2fe" });
  });

  test("a plan with nothing to run fails the run with the planner's reason", async () => {
    const { pool, deps } = setup();
    pool.plan = ok(
      JSON.stringify({
        ...JSON.parse(planJson([], [])),
        nothingToRun: "nothing to run. No task in turbo.json is tagged ci.",
      }),
    );
    const r = await runPipeline(deps, push());
    expect(r.status).toBe("failure");
    expect(r.error).toBe("nothing to run. No task in turbo.json is tagged ci.");
  });

  test("the secrets the run asks for reach every machine it starts", async () => {
    const { pool, deps } = setup();
    pool.plan = ok(planJson([{ id: "a#test", hit: true }], ["a#test"]));
    await runPipeline(deps, { ...push(), secrets: ["DATABASE_URL"] });
    expect(pool.options?.secrets).toEqual(["DATABASE_URL"]);
  });

  test("the record names the machines that were kept, and the cache token never reaches a log", async () => {
    const { pool, deps, store } = setup();
    const token = "t".repeat(48);
    pool.fail.add("a#test");
    pool.keptNames = ["w2"];
    pool.plan = ok(planJson([{ id: "a#test" }], ["a#test"]));
    const original = pool.acquire.bind(pool);
    pool.acquire = async (cpus?: number) => {
      const w = await original(cpus);
      w.run = async (tasks) =>
        tasks.map((t) => ({ id: t.id, status: "failed", seconds: 1, logTail: `TURBO_TOKEN=${token}`, machine: w.id }));
      return w;
    };
    const r = await runPipeline(deps, push("feature"));
    expect(r.kept).toEqual(["w2"]);
    expect(JSON.stringify(r)).not.toContain(token);
    expect((await store.read(`runs/acme-web/${r.id}.logs.json`)) ?? "").not.toContain(token);
    expect(r.results[0]?.logTail).toBe("TURBO_TOKEN=[redacted]");
  });

  test("a report that throws still lets a green push to the default branch promote", async () => {
    const { pool, deps, calls } = setup();
    pool.plan = ok(planJson([{ id: "a#test", hit: true }], ["a#test"]));
    deps.onFinish = async () => {
      throw new Error("GitHub said no");
    };
    const r = await runPipeline(deps, push("main"));
    expect(r.status).toBe("success");
    expect(calls).toContain("promote d00d2fe");
  });

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
      TURBO_API: "https://cache.boxd-turbo-server.boxd.sh",
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

  test("a push to the default branch with changed dependency files installs once and saves the shared dependency snapshot", async () => {
    const { pool, deps, saved, deleted } = setup();
    pool.depsHash = "bbbbbbbbbbbbbbbb";
    pool.plan = ok(planJson([{ id: "a#test" }, { id: "b#test" }], ["a#test", "b#test"]));
    const r = await runPipeline(deps, push("main"));
    expect(pool.installs).toBe(1);
    expect(saved).toEqual(["bt-acme-web-deps-bbbbbbbbbb"]);
    expect(pool.snapshotOpts).toEqual([["bt-acme-web-deps-bbbbbbbbbb", { checkedOut: true }]]);
    expect(r.snapshot).toBe("bt-acme-web-deps-bbbbbbbbbb");
    expect(deleted).toEqual([]);
  });

  test("a branch push with changed dependency files installs into a snapshot for this run only, checked out, deleted after", async () => {
    const { pool, deps, saved, deleted } = setup();
    pool.depsHash = "bbbbbbbbbbbbbbbb";
    pool.plan = ok(planJson([{ id: "a#test" }, { id: "b#test" }], ["a#test", "b#test"]));
    await runPipeline(deps, push("feature"));
    expect(pool.installs).toBe(1);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatch(/^bt-acme-web-run-bbbbbb[a-z0-9]{4}$/);
    // Its machines already have the commit: they check it out, and no token reaches them.
    expect(pool.snapshotOpts).toEqual([[saved[0], { checkedOut: true }]]);
    expect(deleted).toEqual([saved[0]]);
  });

  test("a branch push never restores a dependency snapshot that boxd-turbo run made", async () => {
    const { pool, deps, saved } = setup({ readySnapshots: ["bt-acme-web-dev-bbbbbbbbbb"] });
    pool.depsHash = "bbbbbbbbbbbbbbbb";
    pool.plan = ok(planJson([{ id: "a#test" }], ["a#test"]));
    await runPipeline(deps, push("feature"));
    expect(pool.installs).toBe(1);
    expect(saved[0]).toMatch(/^bt-acme-web-run-/);
  });

  test("boxd-turbo run saves its own dependency snapshot, and restores it next time", async () => {
    const local: RunInput = {
      repo,
      trigger: "local",
      sha: repo.commit,
      ref: "local",
      prepare: { kind: "patch", base: repo.commit, patch: new Uint8Array([1]) },
    };
    const first = setup();
    first.pool.depsHash = "bbbbbbbbbbbbbbbb";
    first.pool.plan = ok(planJson([{ id: "a#test" }], ["a#test"]));
    await runPipeline(first.deps, local);
    expect(first.saved).toEqual(["bt-acme-web-dev-bbbbbbbbbb"]);
    expect(first.deleted).toEqual([]);

    const next = setup({ readySnapshots: ["bt-acme-web-dev-bbbbbbbbbb"] });
    next.pool.depsHash = "bbbbbbbbbbbbbbbb";
    next.pool.plan = ok(planJson([{ id: "a#test" }], ["a#test"]));
    await runPipeline(next.deps, local);
    expect(next.pool.installs).toBe(0);
    expect(next.pool.snapshots).toEqual(["bt-acme-web-dev-bbbbbbbbbb"]);
  });

  test("at the end of a run, the repository's dependency snapshots older than a week are deleted", async () => {
    const day = 86_400_000;
    const at = (ago: number) => ({ createdAt: new Date(Date.now() - ago) });
    const { deps, deleted, pool } = setup({
      listed: [
        { name: "bt-acme-web-deps-0000000000", version: 1, status: "ready", vcpu: 2, ...at(8 * day) },
        { name: "bt-acme-web-deps-1111111111", version: 1, status: "ready", vcpu: 2, ...at(1 * day) },
        { name: "bt-acme-web-dev-2222222222", version: 1, status: "ready", vcpu: 2, ...at(9 * day) },
        { name: "bt-acme-web-run-333333abcd", version: 1, status: "ready", vcpu: 2, ...at(7 * 3600_000) },
        { name: "bt-acme-web-run-444444abcd", version: 1, status: "ready", vcpu: 2, ...at(1 * 3600_000) },
        { name: "bt-acme-web-app-deps-4444444444", version: 1, status: "ready", vcpu: 2, ...at(30 * day) },
        { name: "bt-acme-web-c0ffee1", version: 1, status: "ready", vcpu: 2, ...at(30 * day) },
      ],
    });
    pool.plan = ok(planJson([{ id: "a#test", hit: true }], ["a#test"]));
    await runPipeline(deps, push("feature"));
    expect(deleted.sort()).toEqual([
      "bt-acme-web-deps-0000000000",
      "bt-acme-web-dev-2222222222",
      "bt-acme-web-run-333333abcd",
    ]);
  });

  test("a dependency snapshot that already exists is restored instead of installing", async () => {
    const { pool, deps } = setup({ readySnapshots: ["bt-acme-web-deps-bbbbbbbbbb"] });
    pool.depsHash = "bbbbbbbbbbbbbbbb";
    pool.plan = ok(planJson([{ id: "a#test" }], ["a#test"]));
    await runPipeline(deps, push("feature"));
    expect(pool.installs).toBe(0);
    expect(pool.snapshots).toEqual(["bt-acme-web-deps-bbbbbbbbbb"]);
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
