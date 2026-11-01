// Which boxd-turbo machines a sweep may delete: running machines of runs that are over, and builders and
// workers far older than any run. A failed task's machine, kept on purpose, is never one of them: it
// is hibernated, or someone woke it by connecting, and its delete-after timer runs for a day.

export type SweepMachine = {
  id: string;
  name: string;
  status: string;
  createdAt?: Date | null;
  deleteAt?: Date | null;
  labels?: Record<string, string>;
};

/** Older than this, a running boxd-turbo machine belongs to no live run. */
export const STALE_MS = 3 * 3600_000;
/** A run's machines are deleted within an hour; one whose timer is further off was kept for debugging. */
const KEPT_AFTER_MS = 2 * 3600_000;

export function leftovers<M extends SweepMachine>(
  machines: M[],
  runStatus: (repo: string, run: string) => string | undefined,
  now = Date.now(),
): M[] {
  return machines.filter((m) => {
    if (m.status !== "running") return false;
    if (m.deleteAt && m.deleteAt.getTime() - now > KEPT_AFTER_MS) return false;
    const age = m.createdAt ? now - m.createdAt.getTime() : 0;
    if (age > STALE_MS) return true;
    const run = m.labels?.["boxd-turbo/run"];
    const repo = m.labels?.["boxd-turbo/repo"];
    if (m.labels?.["boxd-turbo"] !== "worker" || !run || !repo) return false;
    const status = runStatus(repo, run);
    return status !== undefined && status !== "running";
  });
}
