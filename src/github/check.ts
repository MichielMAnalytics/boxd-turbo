// The GitHub check: "boxd-ci" on the pushed commit, in progress while the run plans and runs, then
// green or red with a row per task and the end of every failed log.

import type { RunRecord } from "../core/record.js";
import { checkSummary } from "../core/report.js";

export const CHECK_NAME = "boxd-ci";

type Output = { title: string; summary: string; text?: string };

/** The two Octokit calls a check needs (`githubApp.client()` is one). */
export type ChecksApi = {
  rest: {
    checks: {
      create(p: {
        owner: string;
        repo: string;
        name: string;
        head_sha: string;
        status: "in_progress";
        started_at: string;
        output: Output;
      }): Promise<{ data: { id: number } }>;
      update(p: {
        owner: string;
        repo: string;
        check_run_id: number;
        status: "in_progress" | "completed";
        conclusion?: "success" | "failure";
        completed_at?: string;
        output: Output;
      }): Promise<unknown>;
    };
  };
};

const split = (repo: string) => {
  const [owner = "", name = ""] = repo.split("/");
  return { owner, repo: name };
};

export async function startCheck(gh: ChecksApi, repo: string, sha: string): Promise<number> {
  const r = await gh.rest.checks.create({
    ...split(repo),
    name: CHECK_NAME,
    head_sha: sha,
    status: "in_progress",
    started_at: new Date().toISOString(),
    output: { title: "planning", summary: "Turborepo is planning the run on a machine restored from the snapshot." },
  });
  return r.data.id;
}

/** Shows progress while the run is going, and the result once it is over. */
export async function updateCheck(gh: ChecksApi, repo: string, id: number, record: RunRecord, progress?: string) {
  const base = { ...split(repo), check_run_id: id };
  if (record.status === "running") {
    await gh.rest.checks.update({
      ...base,
      status: "in_progress",
      output: { title: progress ?? "running", summary: progress ?? "running" },
    });
    return;
  }
  const out = checkSummary(record);
  await gh.rest.checks.update({
    ...base,
    status: "completed",
    conclusion: record.status === "success" ? "success" : "failure",
    completed_at: record.finishedAt ?? new Date().toISOString(),
    output: { title: out.title, summary: out.summary, ...(out.text ? { text: out.text } : {}) },
  });
}
