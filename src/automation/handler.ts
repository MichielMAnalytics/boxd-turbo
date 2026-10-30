// What the server does with a GitHub push: run CI on the commit, report it as a check, and after a
// green push to the default branch save the next snapshot. Pushes to repositories boxd-ci has no
// record of, tags and deleted branches are ignored. When the automation starts, runs a restart cut
// short are closed, so no check stays in progress.

import type { BoxdLike } from "../boxd/sdk.js";
import { promote, pruneSnapshots, type RepoRecord } from "../boxd/snapshot.js";
import type { Store } from "../boxd/store.js";
import type { Pool, PoolOptions } from "../boxd/worker.js";
import type { RunRecord } from "../core/record.js";
import { formatSeconds } from "../core/report.js";
import { type ChecksApi, startCheck, updateCheck } from "../github/check.js";
import { cacheEnv, runPipeline } from "../pipeline.js";
import { paths, readJson, runningPushRuns, writeJson } from "../state.js";

export type PushEvent = {
  ref: string;
  after: string;
  deleted?: boolean;
  repository: { full_name: string };
};

export type AutomationDeps = {
  boxd: Pick<BoxdLike, "machines" | "snapshots">;
  store: Store;
  server: { cacheUrl: string; token: string; org?: string };
  plannerBundle: Uint8Array;
  github: { client(): Promise<ChecksApi>; getToken(): Promise<string> };
  pool: (o: PoolOptions) => Pool;
  /** Saves the next snapshot (tests replace it). */
  promoteSnapshot?: typeof promote;
  /** Waits between tries at a GitHub call. Default 2 s, then 10 s. */
  retryDelaysMs?: number[];
  log: (line: string) => void;
};

/** Tries a GitHub call again after each delay: a blip must not leave a check in progress for good. */
async function retry<T>(delays: number[], f: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await f();
    } catch (e) {
      if (attempt >= delays.length) throw e;
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}

const RESTARTED = "the automation restarted during this run. Push again to run it.";

/**
 * Closes the push runs a restart cut short: each is recorded as failed, its check completed, and its
 * machines deleted (their timers would, within the hour). Runs from laptops are left alone.
 */
export async function recoverInterruptedRuns(deps: AutomationDeps, startedBefore = Date.now()): Promise<void> {
  const delays = deps.retryDelaysMs ?? [2000, 10_000];
  const scope = deps.server.org ? { org: deps.server.org } : {};
  for (const { path, record: r } of await runningPushRuns(deps.store)) {
    if (Date.parse(r.startedAt) >= startedBefore) continue; // a push this process already took
    const closed: RunRecord = { ...r, status: "failure", error: RESTARTED, finishedAt: new Date().toISOString() };
    await writeJson(deps.store, path, closed);
    deps.log(`${r.repo}: closed ${r.id}, which the restart cut short`);
    for (const m of await deps.boxd.machines.list({ ...scope, labels: { "boxd-ci/run": r.id } }).catch(() => [])) {
      if (m.status === "running") await deps.boxd.machines.delete(m.id).catch(() => {});
    }
    const id = r.checkId;
    if (id === undefined) continue;
    await retry(delays, async () => updateCheck(await deps.github.client(), r.repo, id, closed)).catch((e: Error) =>
      deps.log(`${r.repo}: could not complete the check of ${r.id}: ${e.message}`),
    );
  }
}

export function createHandler(deps: AutomationDeps) {
  const promotions = new Map<string, Promise<unknown>>();
  const promoteSnapshot = deps.promoteSnapshot ?? promote;
  const org = deps.server.org;

  /** One promotion per repository at a time, each starting from the record the last one wrote. */
  const queuePromotion = (repo: string, sha: string, selectors: string[]) => {
    const next = (promotions.get(repo) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const record = await readJson<RepoRecord>(deps.store, paths.repo(repo));
        if (!record) return;
        const promoted = await promoteSnapshot(deps.boxd, {
          record,
          sha,
          fetchToken: await deps.github.getToken(),
          env: cacheEnv({ url: deps.server.cacheUrl, token: deps.server.token }, repo),
          selectors,
          ...(org ? { org } : {}),
          onProgress: (l) => deps.log(`${repo}: ${l}`),
        });
        if (promoted) {
          await writeJson(deps.store, paths.repo(repo), await pruneSnapshots(deps.boxd, promoted, org ? { org } : {}));
          deps.log(`${repo}: runs now start from ${promoted.snapshot} (${sha.slice(0, 7)})`);
        }
      });
    promotions.set(repo, next);
    return next;
  };

  return async function handle(e: PushEvent): Promise<void> {
    if (!e.ref.startsWith("refs/heads/") || e.deleted || /^0+$/.test(e.after)) return;
    const name = e.repository.full_name;
    const repo = await readJson<RepoRecord>(deps.store, paths.repo(name));
    // Another repository whose name maps to the same short name finds this record: not its own.
    if (!repo || repo.repo.toLowerCase() !== name.toLowerCase()) return;
    const branch = e.ref.slice("refs/heads/".length);
    const t0 = Date.now();
    const say = (l: string) =>
      deps.log(`${name}@${e.after.slice(0, 7)} ${formatSeconds((Date.now() - t0) / 1000).padStart(6)}  ${l}`);
    say(`push to ${branch}`);

    const delays = deps.retryDelaysMs ?? [2000, 10_000];
    const check = await retry(delays, async () => startCheck(await deps.github.client(), name, e.after)).catch(
      (err: Error) => {
        say(`could not create the check: ${err.message}`);
        return null;
      },
    );

    await runPipeline(
      {
        boxd: deps.boxd,
        store: deps.store,
        cache: { url: deps.server.cacheUrl, token: deps.server.token },
        ...(org ? { org } : {}),
        plannerBundle: deps.plannerBundle,
        pool: deps.pool,
        onEvent: (ev) => {
          if (ev.type === "phase") say(ev.message);
          else if (ev.type === "plan") say(`${ev.tasks} tasks, ${ev.toRun} to run`);
          else if (ev.type === "done") say(`${ev.result.status} ${ev.result.id} (${formatSeconds(ev.result.seconds)})`);
          else if (ev.type === "skip") say(`skipped ${ev.id}: ${ev.because}`);
        },
        onFinish: async (r) => {
          say(`${r.status}${r.error ? `: ${r.error}` : ""}`);
          if (check !== null)
            // A fresh client: an installation token expires within the hour, and runs can be longer.
            await retry(delays, async () => updateCheck(await deps.github.client(), name, check, r)).catch(
              (err: Error) => say(`could not update the check: ${err.message}`),
            );
        },
        promote: ({ run, selectors }) => queuePromotion(name, run.sha, selectors),
      },
      {
        repo,
        trigger: "push",
        sha: e.after,
        ref: branch,
        prepare: { kind: "commit", sha: e.after, fetchToken: () => deps.github.getToken() },
        ...(repo.secrets?.length ? { secrets: repo.secrets } : {}),
        ...(check !== null ? { checkId: check } : {}),
      },
    );
  };
}
