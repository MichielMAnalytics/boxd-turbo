// The shell a task machine runs, as pure functions of their inputs, and the parser for what comes
// back. Every value that reaches a shell is single-quoted; secrets only ever arrive as environment
// variables of the one command that needs them.

import type { TaskNode } from "../core/graph.js";
import type { TaskResult } from "../core/scheduler.js";

export const SUMMARY_MARK = "::boxd-ci-summary::";
export const LOG_MARK = "::boxd-ci-log::";
/** How much of each task's log comes back to the controller. */
export const LOG_TAIL_BYTES = 20_000;

/** 'quotes' a value for bash. */
export const q = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** A commit hash, checked before it is written into a script. */
export function commit(sha: string): string {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`not a commit hash: ${sha}`);
  return sha;
}

/** Fetches one commit and checks it out. The GitHub token reaches git only as an auth header. */
export function fetchScript(workdir: string, sha: string): string {
  commit(sha);
  const auth = `-c http.extraheader="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$BOXD_CI_FETCH_TOKEN" | base64 -w0)"`;
  return [
    `cd ${q(workdir)}`,
    `if [ -n "$BOXD_CI_FETCH_TOKEN" ]; then git ${auth} fetch -q origin ${sha}; else git fetch -q origin ${sha}; fi`,
    `git checkout -q -f ${sha}`,
  ].join(" && ");
}

/**
 * Puts the base commit back and applies a working-copy patch on top (`boxd-ci run`). Untracked files
 * stay: on a fresh snapshot they are whatever the install generated.
 */
export function applyPatchScript(workdir: string, base: string, patchPath: string): string {
  commit(base);
  return [
    `cd ${q(workdir)}`,
    `{ git cat-file -e ${base}^{commit} 2>/dev/null || git fetch -q origin ${base}; }`,
    `git checkout -q -f ${base}`,
    `if [ -s ${q(patchPath)} ]; then git apply --binary --whitespace=nowarn ${q(patchPath)}; fi`,
  ].join(" && ");
}

/**
 * Deletes every declared output of the run's tasks, so the files a task sees are exactly what
 * Turborepo restores or builds, and never what the snapshot's own warm-up left behind. Negated
 * globs are kept, and nothing under node_modules is touched.
 */
export function cleanOutputsScript(workdir: string, outputs: { dir: string; globs: string[] }[]): string {
  const work = outputs.filter((o) => o.globs.some((g) => !g.startsWith("!")));
  if (work.length === 0) return "true";
  const js = `
const fs = require("node:fs"), path = require("node:path");
if (!fs.globSync) { console.error("boxd-ci: Node.js " + process.version + " has no fs.globSync, so declared outputs were not cleaned (needs Node 22+)"); process.exit(0); }
const [root, spec] = [process.argv[1], JSON.parse(process.argv[2])];
for (const { dir, globs } of spec) {
  const base = path.join(root, dir);
  const keep = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
  const kept = new Set(keep.flatMap((g) => fs.globSync(g, { cwd: base })));
  for (const g of globs.filter((g) => !g.startsWith("!"))) {
    for (const rel of fs.globSync(g, { cwd: base, exclude: (p) => String(p).split(path.sep).includes("node_modules") })) {
      if (kept.has(rel) || rel.split(path.sep).includes("node_modules")) continue;
      const abs = path.join(base, rel);
      try { if (!fs.statSync(abs).isDirectory()) fs.rmSync(abs, { force: true }); } catch {}
    }
  }
}`;
  return `node -e ${q(js)} ${q(workdir)} ${q(JSON.stringify(work))}`;
}

/**
 * Runs exactly these tasks through the repository's own Turborepo, with the remote cache, then
 * prints the run summary and the end of each task's log after markers the controller parses.
 */
export function turboRunScript(workdir: string, tasks: TaskNode[]): string {
  const selectors = tasks.map((t) => q(t.id)).join(" ");
  const logs = tasks
    .map(
      (t) =>
        `echo ${q(`${LOG_MARK}${t.id}`)}; tail -c ${LOG_TAIL_BYTES} ${q(t.logFile ?? "/dev/null")} 2>/dev/null; echo`,
    )
    .join("; ");
  return [
    `cd ${q(workdir)}`,
    "rm -rf .turbo/runs",
    `./node_modules/.bin/turbo run ${selectors} --summarize --cache=local:rw,remote:rw --continue=dependencies-successful > /tmp/boxd-ci-turbo.log 2>&1`,
    "code=$?",
    "tail -c 4000 /tmp/boxd-ci-turbo.log",
    `echo ${q(SUMMARY_MARK)}`,
    "cat .turbo/runs/*.json 2>/dev/null | head -c 50000000",
    "echo",
    logs,
    "exit $code",
  ].join("; ");
}

type SummaryTask = {
  taskId: string;
  cache?: { status?: string };
  execution?: { startTime?: number; endTime?: number; exitCode?: number | null };
};

/** Terminal color and cursor codes: noise in a GitHub check and in `boxd-ci grep`. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape character is the point
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Turns a worker's output into one result per task it was asked to run. */
export function parseRunOutput(raw: string, tasks: TaskNode[], machine: string): TaskResult[] {
  const stdout = raw.replace(ANSI, "");
  const at = stdout.indexOf(SUMMARY_MARK);
  const before = (at < 0 ? stdout : stdout.slice(0, at)).trim();
  const fallback = before.slice(-LOG_TAIL_BYTES) || "the machine returned no output";
  if (at < 0) return tasks.map((t) => ({ id: t.id, status: "failed", seconds: 0, logTail: fallback, machine }));

  // Each marker starts its own line, so text that merely contains one never splits the output.
  const rest = stdout.slice(at + SUMMARY_MARK.length);
  const [summaryText = "", ...chunks] = rest.split(`\n${LOG_MARK}`);
  let summary: { tasks?: SummaryTask[] } = {};
  try {
    summary = JSON.parse(summaryText.trim()) as { tasks?: SummaryTask[] };
  } catch {
    // No summary: every task falls back to turbo's own output below.
  }
  const byId = new Map((summary.tasks ?? []).map((t) => [t.taskId, t]));

  const logs = new Map<string, string>();
  for (const chunk of chunks) {
    const nl = chunk.indexOf("\n");
    logs.set(chunk.slice(0, nl < 0 ? undefined : nl).trim(), nl < 0 ? "" : chunk.slice(nl + 1).trim());
  }

  return tasks.map((t): TaskResult => {
    const s = byId.get(t.id);
    const e = s?.execution;
    const log = logs.get(t.id) || fallback;
    if (!s || !e || typeof e.exitCode !== "number") {
      return { id: t.id, status: "failed", seconds: 0, logTail: log, machine };
    }
    const seconds =
      typeof e.startTime === "number" && typeof e.endTime === "number" ? (e.endTime - e.startTime) / 1000 : 0;
    const status = e.exitCode !== 0 ? "failed" : s.cache?.status === "HIT" ? "restored" : "ran";
    return { id: t.id, status, seconds, logTail: log, machine };
  });
}
