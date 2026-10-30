// Which boxd-ci machines a sweep may delete: running machines of runs that are over, and builders and
// workers far older than any run. A machine that is not running (a failed task's, kept on purpose and
// hibernated or paused, whatever the SDK calls that state) is never one of them.

export type SweepMachine = {
  id: string;
  name: string;
  status: string;
  createdAt?: Date | null;
  labels?: Record<string, string>;
};

/** Older than this, a running boxd-ci machine belongs to no live run. */
export const STALE_MS = 3 * 3600_000;

export function leftovers<M extends SweepMachine>(
  machines: M[],
  runStatus: (repo: string, run: string) => string | undefined,
  now = Date.now(),
): M[] {
  return machines.filter((m) => {
    if (m.status !== "running") return false;
    const age = m.createdAt ? now - m.createdAt.getTime() : 0;
    if (age > STALE_MS) return true;
    const run = m.labels?.["boxd-ci/run"];
    const repo = m.labels?.["boxd-ci/repo"];
    if (m.labels?.["boxd-ci"] !== "worker" || !run || !repo) return false;
    const status = runStatus(repo, run);
    return status !== undefined && status !== "running";
  });
}
