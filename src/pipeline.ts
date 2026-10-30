// One CI run, from either door: a push (the automation on the server) or `boxd-ci run` (a laptop).
//
//   restore the planner's machine → check the dependency files → plan with Turborepo
//   → schedule the uncached tasks on machines → store the record → report → promote

import { q } from "./boxd/scripts.js";
import type { BoxdLike, ExecOutput } from "./boxd/sdk.js";
import {
  depsHashScript,
  depsSnapshotName,
  devSnapshotName,
  PLANNER_PATH,
  pruneDepsSnapshots,
  type RepoRecord,
  repoSlug,
  runSnapshotName,
  saveDepsSnapshot,
  snapshotReady,
} from "./boxd/snapshot.js";
import type { Store } from "./boxd/store.js";
import { PATCH_PATH, type Pool, type PoolOptions, type PrepareSpec } from "./boxd/worker.js";
import { buildGraph, closureOutputs, type TaskGraph, toRun } from "./core/graph.js";
import { newRunId, type RunRecord } from "./core/record.js";
import { type SchedulerEvent, schedule } from "./core/scheduler.js";
import type { Plan } from "./planner/planner.js";
import { paths, readJson, writeJson } from "./state.js";

export type RunInput = {
  repo: RepoRecord;
  trigger: RunRecord["trigger"];
  /** The commit (a push), or the snapshot's commit the working copy is applied to (a local run). */
  sha: string;
  /** The branch, or "local". */
  ref: string;
  prepare: PrepareSpec;
  /** Names of boxd secrets every machine of the run gets. */
  secrets?: string[];
  /** The GitHub check that reports the run, kept in its record. */
  checkId?: number;
};

export type PipelineEvent =
  | SchedulerEvent
  | { type: "phase"; message: string }
  | { type: "plan"; tasks: number; toRun: number };

export type PipelineDeps = {
  boxd: { snapshots: Pick<BoxdLike["snapshots"], "create" | "get" | "list" | "delete"> };
  store: Store;
  cache: { url: string; token: string };
  org?: string;
  /** dist/planner.mjs, run on the planner's machine. */
  plannerBundle: Uint8Array;
  pool: (o: PoolOptions) => Pool;
  /** Overrides .boxd-ci.json's maxMachines. */
  maxMachines?: number;
  /** After a green push to the default branch, once the run is reported. */
  promote?: (o: { repo: RepoRecord; run: RunRecord; selectors: string[] }) => Promise<void>;
  onStart?: (r: RunRecord) => Promise<void> | void;
  onFinish?: (r: RunRecord) => Promise<void> | void;
  onEvent?: (e: PipelineEvent) => void;
  signal?: AbortSignal;
  now?: () => Date;
};

/** What every Turborepo run of this repository gets: the remote cache, and CI=1 everywhere. */
export function cacheEnv(cache: { url: string; token: string }, repo: string): Record<string, string> {
  return {
    TURBO_API: cache.url,
    TURBO_TOKEN: cache.token,
    TURBO_TEAM: repoSlug(repo),
    TURBO_TELEMETRY_DISABLED: "1",
    TURBO_NO_UPDATE_NOTIFIER: "1",
    CI: "1",
  };
}

/** Every secret value replaced, so a task that prints its environment shows none in a check or a log. */
const redact = (text: string, secrets: string[]) =>
  secrets.reduce((t, s) => (s.length >= 8 ? t.replaceAll(s, "[redacted]") : t), text);

const outputTail = (out: ExecOutput) =>
  `${out.stderr}\n${out.stdout}`.trim().slice(-3000) || `exit code ${out.exitCode}`;

function parsePlan(out: ExecOutput): Plan {
  let parsed: (Plan & { error?: string }) | undefined;
  try {
    parsed = JSON.parse(out.stdout.trim()) as Plan & { error?: string };
  } catch {
    // Not JSON: the planner never got to print (node missing, the machine broke).
  }
  if (out.exitCode !== 0 || !parsed || parsed.error) {
    throw new Error(`planning failed: ${parsed?.error ?? outputTail(out)}`);
  }
  return parsed;
}

class Cancelled extends Error {}

export async function runPipeline(deps: PipelineDeps, input: RunInput): Promise<RunRecord> {
  const now = deps.now ?? (() => new Date());
  const repo = input.repo;
  const id = newRunId(input.sha, now());
  const record: RunRecord = {
    id,
    repo: repo.repo,
    sha: input.sha,
    ref: input.ref,
    trigger: input.trigger,
    startedAt: now().toISOString(),
    status: "running",
    results: [],
    machines: 0,
    snapshot: repo.snapshot,
    warnings: [],
    ...(input.checkId !== undefined ? { checkId: input.checkId } : {}),
  };
  const phase = (message: string) => deps.onEvent?.({ type: "phase", message });
  const cancelled = () => {
    if (deps.signal?.aborted) throw new Cancelled("the run was cancelled");
  };
  await writeJson(deps.store, paths.run(repo.repo, id), record).catch(() => {});
  await deps.onStart?.(record);

  const env = cacheEnv(deps.cache, repo.repo);
  let graph: TaskGraph | undefined;
  const pool = deps.pool({
    snapshot: repo.snapshot,
    ...(deps.org ? { org: deps.org } : {}),
    baseCpus: repo.cpus,
    workdir: repo.workdir,
    prepare: input.prepare,
    env,
    runId: id,
    repo: repoSlug(repo.repo),
    ...(input.secrets?.length ? { secrets: input.secrets } : {}),
    outputsOf: (tasks) => (graph ? closureOutputs(graph, tasks) : tasks.map((t) => ({ dir: t.dir, globs: t.outputs }))),
  });
  let selectors: string[] = [];
  let runSnapshot: string | undefined;
  const logs: Record<string, string> = {};
  const secretValues = [deps.cache.token];

  try {
    phase(`restoring ${repo.snapshot}`);
    let planner = await pool.acquire();
    cancelled();

    const hash = (await planner.sh(depsHashScript(repo.workdir))).stdout.trim();
    if (/^[0-9a-f]{16}$/.test(hash) && hash !== repo.depsHash) {
      // A dependency snapshot holds whatever its install ran, so who made it decides who restores it.
      const local = input.trigger === "local";
      const shared = depsSnapshotName(repo.repo, hash);
      const reusable = local ? [shared, devSnapshotName(repo.repo, hash)] : [shared];
      let found: string | undefined;
      for (const name of reusable) if (!found && (await snapshotReady(deps.boxd, name, deps.org))) found = name;
      if (found) {
        phase(`the dependency files changed, and ${found} has them installed`);
        pool.setSnapshot(found);
        await planner.release({ failed: false });
        planner = await pool.acquire();
        record.snapshot = found;
      } else {
        const name = local
          ? devSnapshotName(repo.repo, hash)
          : input.ref === repo.defaultBranch
            ? shared
            : runSnapshotName(repo.repo, hash, Math.random().toString(36).slice(2, 6).padEnd(4, "0"));
        phase("the dependency files changed, installing them once for every machine of this run");
        await saveDepsSnapshot(deps.boxd, planner, {
          record: repo,
          name,
          ...(deps.org ? { org: deps.org } : {}),
          ...(input.prepare.kind === "patch" ? { patch: { path: PATCH_PATH, data: input.prepare.patch } } : {}),
        });
        // Saved at the run's commit: its machines check that out, and no token reaches them.
        pool.setSnapshot(name, input.prepare.kind === "commit" ? { checkedOut: true } : undefined);
        if (name !== shared && !local) runSnapshot = name;
        record.snapshot = name;
      }
      cancelled();
    }

    phase("planning with Turborepo");
    cancelled();
    await planner.upload(PLANNER_PATH, deps.plannerBundle);
    const plan = parsePlan(
      await planner.sh(`cd ${q(repo.workdir)} && node ${PLANNER_PATH} .`, { env, timeout: 15 * 60_000 }),
    );
    cancelled();
    record.warnings = plan.warnings;
    if (plan.selectors.length === 0) throw new Error(plan.nothingToRun ?? "nothing to run");
    selectors = plan.selectors.map((s) => s.selector);
    graph = buildGraph(plan.dry, plan.selectors);
    deps.onEvent?.({ type: "plan", tasks: graph.nodes.size, toRun: toRun(graph).length });
    pool.park(planner); // the first task group of its size runs where the planner did

    const durations = (await readJson<Record<string, number>>(deps.store, paths.durations(repo.repo))) ?? {};
    const started = new Map<string, number>();
    const t0 = Date.parse(record.startedAt);
    const results = await schedule(graph, pool, {
      maxWorkers: deps.maxMachines ?? plan.config.maxMachines,
      packSeconds: plan.config.packSeconds,
      durations,
      ...(deps.signal ? { signal: deps.signal } : {}),
      onEvent: (e) => {
        if (e.type === "start")
          for (const id of e.tasks) started.set(id, Math.round((now().getTime() - t0) / 100) / 10);
        deps.onEvent?.(e);
      },
    });
    for (const r of results) {
      const at = started.get(r.id);
      if (at !== undefined) r.at = at;
      r.logTail = redact(r.logTail, secretValues);
      if (r.status === "ran" || r.status === "failed") logs[r.id] = r.logTail;
    }
    // The record keeps the logs a reader needs first; every log is in the run's logs file.
    record.results = results.map((r) => (r.status === "failed" || r.status === "skipped" ? r : { ...r, logTail: "" }));
    record.status = results.some((r) => r.status === "failed") ? "failure" : "success";
  } catch (e) {
    record.status = "failure";
    record.error = deps.signal?.aborted ? "the run was cancelled" : redact((e as Error).message, secretValues);
  } finally {
    await pool.drain();
    record.machines = pool.machines();
    record.machineSeconds = pool.machineSeconds();
    const kept = pool.kept();
    if (kept.length) record.kept = kept;
    record.finishedAt = now().toISOString();
    if (runSnapshot)
      await deps.boxd.snapshots.delete(runSnapshot, deps.org ? { org: deps.org } : undefined).catch(() => {});
  }

  await Promise.all([
    writeJson(deps.store, paths.run(repo.repo, id), record),
    Object.keys(logs).length ? writeJson(deps.store, paths.logs(repo.repo, id), logs) : undefined,
    updateDurations(deps.store, repo.repo, record),
  ]).catch((e: Error) => phase(`could not store the run: ${e.message}`));
  // A report that fails (GitHub down, a token that expired) must not keep the default branch from moving on.
  try {
    await deps.onFinish?.(record);
  } catch (e) {
    phase(`could not report the run: ${(e as Error).message}`);
  }
  await pruneDepsSnapshots(deps.boxd, repo.repo, deps.org ? { org: deps.org } : {}).catch(() => {});

  const green = record.status === "success" && input.trigger === "push" && input.ref === repo.defaultBranch;
  if (green && deps.promote) {
    await deps.promote({ repo, run: record, selectors }).catch((e: Error) => phase(`promotion failed: ${e.message}`));
  }
  return record;
}

/** Each task that executed keeps its latest time; the rest keep theirs. */
async function updateDurations(store: Store, repo: string, record: RunRecord) {
  const executed = record.results.filter((r) => r.status === "ran" || r.status === "failed");
  if (!executed.length) return;
  const durations = (await readJson<Record<string, number>>(store, paths.durations(repo))) ?? {};
  for (const r of executed) durations[r.id] = Math.round(r.seconds * 10) / 10;
  await writeJson(store, paths.durations(repo), durations);
}
