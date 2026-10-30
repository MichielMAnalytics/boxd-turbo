// What one run leaves behind: enough to show it in a GitHub check, in `boxd-ci ls` and `logs`, and
// to learn task durations for the next run's priorities and packing.

import type { TaskResult } from "./scheduler.js";

export type RunRecord = {
  id: string;
  repo: string;
  sha: string;
  ref: string;
  /** "push": GitHub sent it. "local": `boxd-ci run` from a working copy. */
  trigger: "push" | "local";
  startedAt: string;
  finishedAt?: string;
  status: "running" | "success" | "failure";
  results: TaskResult[];
  /** Machines the run started for its tasks. */
  machines: number;
  /** Seconds those machines were up, by vCPU count. */
  machineSeconds?: Record<string, number>;
  snapshot: string;
  warnings: string[];
  /** Why the run stopped before or around its tasks (planner, snapshot, an exception). */
  error?: string;
};

export const runSeconds = (r: RunRecord): number =>
  r.finishedAt ? (Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000 : 0;

/** Each task's duration in the latest of these runs that ran it, for priorities and packing. */
export function learnDurations(runs: RunRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  const byTime = [...runs].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  for (const run of byTime) for (const t of run.results) if (t.status === "ran") out[t.id] = t.seconds;
  return out;
}

/** A sortable, readable run id: 20261030-101503-a1b2c3d. */
export function newRunId(sha: string, now = new Date()): string {
  const iso = now.toISOString(); // 2026-10-30T10:15:03.000Z
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}-${sha.slice(0, 7)}`;
}
