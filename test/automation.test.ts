import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type AutomationDeps, createHandler, type PushEvent } from "../src/automation/handler.js";
import type { RepoRecord } from "../src/boxd/snapshot.js";
import { fsStore } from "../src/boxd/store.js";
import type { BoxWorker, Pool } from "../src/boxd/worker.js";
import type { ChecksApi } from "../src/github/check.js";
import { paths, readJson, writeJson } from "../src/state.js";

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
        script.includes("sha256sum")
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
  };
};

const repo: RepoRecord = {
  version: 1,
  repo: "acme/web",
  cloneUrl: "https://github.com/acme/web.git",
  defaultBranch: "main",
  workdir: "/home/boxd/work/web",
  slots: ["bci-acme-web-a", "bci-acme-web-b"],
  snapshot: "bci-acme-web-a",
  commit: "c0ffee1",
  depsHash: "aaaaaaaaaaaaaaaa",
  cpus: 2,
  builtAt: "2026-10-30T00:00:00.000Z",
};

const setup = async (o: { fail?: boolean } = {}) => {
  const store = fsStore(mkdtempSync(join(tmpdir(), "boxd-ci-auto-")));
  await writeJson(store, paths.repo("acme/web"), repo);
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
          return {};
        },
      },
    },
  };
  const promoted: string[] = [];
  const chain: string[] = [];
  const deps: AutomationDeps = {
    boxd: {
      snapshots: { create: async () => ({ version: 1 }), get: async () => Promise.reject(new Error("none")) },
    } as never,
    store,
    server: { cacheUrl: "https://cache.x.boxd.sh", token: "t" },
    plannerBundle: new Uint8Array(),
    github: { client: async () => gh, getToken: async () => "ghs_fresh" },
    pool: () => fakePool(o.fail),
    promoteSnapshot: async (_boxd, { record, sha }) => {
      promoted.push(sha);
      chain.push(`${record.commit}->${sha}`);
      await new Promise((r) => setTimeout(r, 5));
      return { ...record, snapshot: "bci-acme-web-b", commit: sha };
    },
    log: () => {},
  };
  return { store, checks, promoted, chain, handle: createHandler(deps) };
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
    expect(next).toMatchObject({ snapshot: "bci-acme-web-b", commit: "d00d2fe1234567" });
  });

  test("promotions of one repository run one after another, each from the record the last one wrote", async () => {
    const { chain, handle } = await setup();
    await Promise.all([handle(event({ after: "aaaa111" })), handle(event({ after: "bbbb222" }))]);
    expect(chain).toHaveLength(2);
    const [first, second] = chain.map((c) => c.split("->"));
    expect(first?.[0]).toBe("c0ffee1");
    expect(second?.[0]).toBe(first?.[1]);
  });
});
