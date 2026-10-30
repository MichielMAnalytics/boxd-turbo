import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type AutomationDeps,
  createHandler,
  type PushEvent,
  recoverInterruptedRuns,
} from "../src/automation/handler.js";
import { DEPS_HASH_MARK, type RepoRecord } from "../src/boxd/snapshot.js";
import { fsStore } from "../src/boxd/store.js";
import type { BoxWorker, Pool, PoolOptions } from "../src/boxd/worker.js";
import type { RunRecord } from "../src/core/record.js";
import type { ChecksApi } from "../src/github/check.js";
import { paths, readJson, runningPushRuns, writeJson } from "../src/state.js";

const planJson = JSON.stringify({
  version: 1,
  turboVersion: "2.11.10",
  selectors: [{ selector: "web#test" }],
  warnings: [],
  config: { maxMachines: 32, packSeconds: 10 },
  dry: {
    tasks: [
      {
        taskId: "web#test",
        task: "test",
        package: "web",
        directory: "apps/web",
        hash: "h",
        cache: { status: "MISS" },
        dependencies: [],
        outputs: [],
        command: "vitest",
      },
    ],
  },
});

/** Every machine plans and runs successfully, unless `fail` names the task. */
const fakePool = (fail = false): Pool => {
  let n = 0;
  const worker = (): BoxWorker => {
    n += 1;
    const id = `w${n}`;
    return {
      id,
      machineId: id,
      cpus: 2,
      run: async (tasks) =>
        tasks.map((t) => ({ id: t.id, status: fail ? "failed" : "ran", seconds: 3, logTail: "FAIL x", machine: id })),
      release: async () => {},
      upload: async () => {},
      sh: async (script) =>
        script.includes(DEPS_HASH_MARK)
          ? { stdout: "aaaaaaaaaaaaaaaa\n", stderr: "", exitCode: 0 }
          : { stdout: planJson, stderr: "", exitCode: 0 },
    };
  };
  const parked: BoxWorker[] = [];
  return {
    acquire: async () => parked.pop() ?? worker(),
    setSnapshot: () => {},
    park: (w) => parked.push(w),
    drain: async () => {},
    machines: () => n,
    kept: () => [],
    machineSeconds: () => ({}),
  };
};

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

const setup = async (
  o: { fail?: boolean; refuseText?: boolean; record?: RepoRecord; clientFailures?: number[] } = {},
) => {
  const store = fsStore(mkdtempSync(join(tmpdir(), "boxd-ci-auto-")));
  await writeJson(store, paths.repo("acme/web"), o.record ?? repo);
  const checks: { op: string; [k: string]: unknown }[] = [];
  const gh: ChecksApi = {
    rest: {
      checks: {
        create: async (p) => {
          checks.push({ op: "create", ...p });
          return { data: { id: 77 } };
        },
        update: async (p) => {
          checks.push({ op: "update", ...p });
          if (o.refuseText && p.output.text) throw new Error("Validation Failed: Only 65535 characters are allowed");
          return {};
        },
      },
    },
  };
  const promoted: string[] = [];
  const chain: string[] = [];
  const clients = { n: 0 };
  const pools: PoolOptions[] = [];
  const deletedMachines: string[] = [];
  const deps: AutomationDeps = {
    boxd: {
      snapshots: { create: async () => ({ version: 1 }), get: async () => Promise.reject(new Error("none")) },
      machines: {
        list: async (q: { labels: Record<string, string> }) =>
          q.labels["boxd-ci/run"] === "20261030-100000-d00d2fe"
            ? [{ id: "m9", name: "bci-d00d2fe-x-1", status: "running" }]
            : [],
        delete: async (id: string) => {
          deletedMachines.push(id);
        },
      },
    } as never,
    store,
    server: { cacheUrl: "https://cache.x.boxd.sh", token: "t" },
    plannerBundle: new Uint8Array(),
    github: {
      client: async () => {
        clients.n += 1;
        if (o.clientFailures?.includes(clients.n)) throw new Error("GitHub is unavailable");
        return gh;
      },
      getToken: async () => "ghs_fresh",
    },
    pool: (opts) => {
      pools.push(opts);
      return fakePool(o.fail);
    },
    retryDelaysMs: [0, 0],
    promoteSnapshot: async (_boxd, { record, sha }) => {
      promoted.push(sha);
      chain.push(`${record.commit}->${sha}`);
      await new Promise((r) => setTimeout(r, 5));
      return { ...record, snapshot: `bci-acme-web-${sha.slice(0, 7)}`, commit: sha };
    },
    log: () => {},
  };
  return { store, checks, promoted, chain, clients, pools, deletedMachines, deps, handle: createHandler(deps) };
};

const event = (o: Partial<PushEvent> = {}): PushEvent => ({
  ref: "refs/heads/main",
  after: "d00d2fe1234567",
  deleted: false,
  repository: { full_name: "acme/web" },
  ...o,
});

describe("the push handler", () => {
  test("ignores tags, deleted branches and repositories boxd-ci does not know", async () => {
    const { checks, handle } = await setup();
    await handle(event({ ref: "refs/tags/v1" }));
    await handle(event({ deleted: true, after: "0000000000000000000000000000000000000000" }));
    await handle(event({ repository: { full_name: "acme/other" } }));
    expect(checks).toEqual([]);
  });

  test("creates the boxd-ci check when the run starts and completes it with the result", async () => {
    const { checks, handle } = await setup();
    await handle(event({ ref: "refs/heads/feature" }));
    expect(checks[0]).toMatchObject({
      op: "create",
      owner: "acme",
      repo: "web",
      name: "boxd-ci",
      head_sha: "d00d2fe1234567",
      status: "in_progress",
    });
    const done = checks.at(-1) as { op: string; conclusion: string; output: { title: string } };
    expect(done).toMatchObject({ op: "update", check_run_id: 77, status: "completed", conclusion: "success" });
    expect(done.output.title).toMatch(/^green in \d+s: 1 ran, 0 restored$/);
  });

  test("a check GitHub refuses is completed again with the summary alone, never left in progress", async () => {
    const { checks, handle } = await setup({ fail: true, refuseText: true });
    await handle(event({ ref: "refs/heads/feature" }));
    const last = checks.at(-1) as {
      op: string;
      status: string;
      conclusion: string;
      output: { text?: string; summary: string };
    };
    expect(last).toMatchObject({ op: "update", status: "completed", conclusion: "failure" });
    expect(last.output.text).toBeUndefined();
    expect(last.output.summary).toContain("boxd-ci logs");
  });

  test("the result is reported with a client asked for at the end, since tokens expire within an hour", async () => {
    const { clients, handle } = await setup();
    await handle(event({ ref: "refs/heads/feature" }));
    expect(clients.n).toBe(2);
  });

  test("a failed run completes the check as a failure, and nothing is promoted", async () => {
    const { checks, promoted, handle } = await setup({ fail: true });
    await handle(event());
    expect(checks.at(-1)).toMatchObject({ conclusion: "failure" });
    expect(promoted).toEqual([]);
  });

  test("a green push to the default branch becomes the next snapshot", async () => {
    const { store, promoted, handle } = await setup();
    await handle(event());
    expect(promoted).toEqual(["d00d2fe1234567"]);
    const next = await readJson<RepoRecord>(store, paths.repo("acme/web"));
    expect(next).toMatchObject({ snapshot: "bci-acme-web-d00d2fe", commit: "d00d2fe1234567" });
  });

  test("promotions of one repository run one after another, each from the record the last one wrote", async () => {
    const { chain, handle } = await setup();
    await Promise.all([handle(event({ after: "aaaa111" })), handle(event({ after: "bbbb222" }))]);
    expect(chain).toHaveLength(2);
    const [first, second] = chain.map((c) => c.split("->"));
    expect(first?.[0]).toBe("c0ffee1");
    expect(second?.[0]).toBe(first?.[1]);
  });

  test("a push from another repository whose name maps to the same record is ignored", async () => {
    const { checks, pools, handle } = await setup();
    await handle(event({ repository: { full_name: "acme/web." } }));
    expect(checks).toEqual([]);
    expect(pools).toEqual([]);
  });

  test("the run gets the record's secrets, and its record keeps the check's id", async () => {
    const { store, pools, handle } = await setup({ record: { ...repo, secrets: ["DATABASE_URL"] } });
    await handle(event({ ref: "refs/heads/feature" }));
    expect(pools[0]?.secrets).toEqual(["DATABASE_URL"]);
    const [name] = await store
      .list(paths.runs("acme/web"))
      .then((n) => n.filter((x) => /^\d{8}-\d{6}-[0-9a-f]+\.json$/.test(x)));
    expect((await readJson<RunRecord>(store, `${paths.runs("acme/web")}/${name}`))?.checkId).toBe(77);
  });

  test("a GitHub client that fails at the end is asked again until the check completes", async () => {
    const { checks, handle } = await setup({ clientFailures: [2] });
    await handle(event({ ref: "refs/heads/feature" }));
    expect(checks.at(-1)).toMatchObject({ op: "update", status: "completed", conclusion: "success" });
  });

  test("a GitHub client that fails at the start still runs CI, and a green default branch still promotes", async () => {
    const { checks, promoted, handle } = await setup({ clientFailures: [1, 2, 3] });
    await handle(event());
    expect(checks).toEqual([]);
    expect(promoted).toEqual(["d00d2fe1234567"]);
  });
});

describe("after the automation restarts", () => {
  test("a push run it left running is closed as failed, its check completed and its machines deleted; local runs stay", async () => {
    const { store, checks, deletedMachines, deps } = await setup();
    const running = (id: string, trigger: RunRecord["trigger"], checkId?: number): RunRecord => ({
      id,
      repo: "acme/web",
      sha: "d00d2fe",
      ref: trigger === "push" ? "main" : "local",
      trigger,
      startedAt: "2026-10-30T10:00:00.000Z",
      status: "running",
      results: [],
      machines: 0,
      snapshot: repo.snapshot,
      warnings: [],
      ...(checkId ? { checkId } : {}),
    });
    await writeJson(
      store,
      paths.run("acme/web", "20261030-100000-d00d2fe"),
      running("20261030-100000-d00d2fe", "push", 5),
    );
    await writeJson(
      store,
      paths.run("acme/web", "20261030-100500-c0ffee1"),
      running("20261030-100500-c0ffee1", "local"),
    );
    await recoverInterruptedRuns(deps);
    const push = await readJson<RunRecord>(store, paths.run("acme/web", "20261030-100000-d00d2fe"));
    expect(push).toMatchObject({
      status: "failure",
      error: "the automation restarted during this run. Push again to run it.",
    });
    expect(checks.at(-1)).toMatchObject({ op: "update", check_run_id: 5, status: "completed", conclusion: "failure" });
    expect(deletedMachines).toEqual(["m9"]);
    expect((await readJson<RunRecord>(store, paths.run("acme/web", "20261030-100500-c0ffee1")))?.status).toBe(
      "running",
    );
  });
});

describe("runningPushRuns", () => {
  test("finds the push runs still marked running, in every repository, with their files", async () => {
    const store = fsStore(mkdtempSync(join(tmpdir(), "boxd-ci-running-")));
    const base = {
      sha: "d00d2fe",
      ref: "main",
      startedAt: "2026-10-30T10:00:00.000Z",
      results: [],
      machines: 0,
      snapshot: "s",
      warnings: [],
    };
    await writeJson(store, paths.run("acme/web", "20261030-100000-d00d2fe"), {
      ...base,
      id: "20261030-100000-d00d2fe",
      repo: "acme/web",
      trigger: "push",
      status: "running",
    });
    await writeJson(store, paths.run("acme/web", "20261030-090000-d00d2fe"), {
      ...base,
      id: "20261030-090000-d00d2fe",
      repo: "acme/web",
      trigger: "push",
      status: "success",
    });
    await writeJson(store, paths.run("acme/api", "20261030-110000-d00d2fe"), {
      ...base,
      id: "20261030-110000-d00d2fe",
      repo: "acme/api",
      trigger: "local",
      status: "running",
    });
    await writeJson(store, paths.durations("acme/web"), {});
    const found = await runningPushRuns(store);
    expect(found.map((f) => [f.path, f.record.id])).toEqual([
      ["runs/acme-web/20261030-100000-d00d2fe.json", "20261030-100000-d00d2fe"],
    ]);
  });
});
