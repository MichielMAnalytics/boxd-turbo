// What the server does with a GitHub push: run CI on the commit, report it as a check, and after a
// green push to the default branch save the next snapshot. Pushes to repositories boxd-ci has no
// record of, tags and deleted branches are ignored.

import type { BoxdLike } from "../boxd/sdk.js";
import { promote, type RepoRecord } from "../boxd/snapshot.js";
import type { Store } from "../boxd/store.js";
import type { Pool, PoolOptions } from "../boxd/worker.js";
import { formatSeconds } from "../core/report.js";
import { type ChecksApi, startCheck, updateCheck } from "../github/check.js";
import { cacheEnv, runPipeline } from "../pipeline.js";
import { paths, readJson, writeJson } from "../state.js";

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
  log: (line: string) => void;
};

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
          await writeJson(deps.store, paths.repo(repo), promoted);
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
    if (!repo) return;
    const branch = e.ref.slice("refs/heads/".length);
    const t0 = Date.now();
    const say = (l: string) =>
      deps.log(`${name}@${e.after.slice(0, 7)} ${formatSeconds((Date.now() - t0) / 1000).padStart(6)}  ${l}`);
    say(`push to ${branch}`);

    const gh = await deps.github.client();
    const check = await startCheck(gh, name, e.after).catch((err: Error) => {
      say(`could not create the check: ${err.message}`);
      return null;
    });

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
            await updateCheck(gh, name, check, r).catch((err: Error) =>
              say(`could not update the check: ${err.message}`),
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
      },
    );
  };
}
