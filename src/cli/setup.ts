// The account-side setup that `init` does in full and `run` does in part: the repository's first
// snapshot, the push automation on the server, and the boxd GitHub App's access.

import { createHash } from "node:crypto";
import { q } from "../boxd/scripts.js";
import type { BoxdLike } from "../boxd/sdk.js";
import { SERVER_ROOT, type ServerInfo } from "../boxd/server.js";
import { buildSnapshot, type RepoRecord } from "../boxd/snapshot.js";
import type { Store } from "../boxd/store.js";
import { cacheEnv } from "../pipeline.js";
import { paths, readJson, writeJson } from "../state.js";
import { bundled, type Ctx } from "./context.js";
import { defaultBranch, githubToken, remoteHead } from "./git.js";

/** The repository's snapshot record, building the first snapshot when there is none (or on --rebuild). */
export async function ensureRepoRecord(
  ctx: Ctx,
  boxd: BoxdLike,
  server: ServerInfo,
  store: Store,
  say: (m: string) => void,
  o: { rebuild?: boolean } = {},
): Promise<RepoRecord> {
  const existing = await readJson<RepoRecord>(store, paths.repo(ctx.repo));
  if (existing && !o.rebuild) return existing;
  const branch = defaultBranch(ctx.root);
  const sha = remoteHead(ctx.root, branch);
  say(`building the snapshot of ${ctx.repo} from ${branch} (${sha.slice(0, 7)}): a clone and an install, once`);
  const token = githubToken();
  const record = await buildSnapshot(boxd, {
    ...(ctx.org ? { org: ctx.org } : {}),
    repo: { repo: ctx.repo, cloneUrl: ctx.cloneUrl, defaultBranch: branch },
    sha,
    ...(token ? { fetchToken: token } : {}),
    env: cacheEnv({ url: server.cacheUrl, token: server.token }, ctx.repo),
    // No warm-up here: the first run builds every task across its machines, far sooner than one
    // machine could, and fills the cache; promotions keep the snapshot warm after that.
    selectors: [],
    onProgress: say,
  });
  await writeJson(store, paths.repo(ctx.repo), record);
  say(`snapshot ${record.snapshot} is ready`);
  return record;
}

const AUTOMATION_DIR = `${SERVER_ROOT}/automation`;

type Job = { id?: string; file?: string; path?: string; state?: string; status?: string };

/**
 * Puts the automation and the planner on the server and makes sure the job runs the current
 * version. A restart would stop runs in progress, so with one in progress it waits for the next init.
 */
export async function installAutomation(boxd: BoxdLike, server: ServerInfo, say: (m: string) => void) {
  const m = boxd.machines;
  const code = bundled("boxd-ci.run.mjs");
  const planner = bundled("planner.mjs");
  const version = createHash("sha256").update(code).update(planner).digest("hex").slice(0, 16);
  const sh = async (script: string) => m.exec(server.machineId, { command: ["bash", "-c", script], timeout: 120_000 });

  const current = (await sh(`cat ${q(`${AUTOMATION_DIR}/version`)} 2>/dev/null || true`)).stdout.trim();
  const jobs = await sh("run jobs --json 2>/dev/null || echo '[]'");
  const job = parseJobs(jobs.stdout).find((j) => JSON.stringify(j).includes("boxd-ci.run.ts"));
  if (job && current === version) {
    say(`the push automation on ${server.name} is up to date`);
    return;
  }
  if (job) {
    const busy = await sh(
      `cd ${q(SERVER_ROOT)} && find runs -name '*.json' -mmin -90 -exec grep -l '"status": "running"' {} + 2>/dev/null | head -1`,
    );
    if (busy.stdout.trim()) {
      say(`a run is in progress on ${server.name}: run init again when it is done to update the automation`);
      return;
    }
  }
  await sh(`mkdir -p ${q(AUTOMATION_DIR)}`);
  await m.files.upload(server.machineId, `${AUTOMATION_DIR}/boxd-ci.run.ts`, code);
  await m.files.upload(server.machineId, `${AUTOMATION_DIR}/planner.mjs`, planner);
  const start = job?.id ? `run restart ${q(job.id)}` : "run boxd-ci.run.ts";
  const out = await sh(`cd ${q(AUTOMATION_DIR)} && ${start} 2>&1 && echo ${q(version)} > version`);
  if (out.exitCode !== 0) throw new Error(`starting the push automation failed: ${out.stdout.trim().slice(-1500)}`);
  say(`the push automation ${job ? "was updated" : "is running"} on ${server.name}`);
}

function parseJobs(text: string): Job[] {
  try {
    const v = JSON.parse(text) as unknown;
    if (Array.isArray(v)) return v as Job[];
    if (v && typeof v === "object") {
      const list = Object.values(v).find(Array.isArray);
      return (list as Job[] | undefined) ?? [];
    }
  } catch {
    // Older runtimes print YAML even with --json; nothing to reuse then.
  }
  return [];
}

export type GithubAccess = "ok" | "no-app" | "no-repo" | "unknown";

/** Whether the org's boxd GitHub App can read the repository, asked from the server. */
export async function githubAccess(boxd: BoxdLike, server: ServerInfo, repo: string): Promise<GithubAccess> {
  const script = `t=$(run github-app get-token 2>/dev/null) || { echo no-app; exit 0; }
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $t" -H 'Accept: application/vnd.github+json' ${q(`https://api.github.com/repos/${repo}`)})
echo "repo:$code"`;
  const out = await boxd.machines.exec(server.machineId, { command: ["bash", "-c", script], timeout: 60_000 });
  const s = out.stdout.trim();
  if (s === "no-app") return "no-app";
  if (s === "repo:200") return "ok";
  if (s.startsWith("repo:404") || s.startsWith("repo:403")) return "no-repo";
  return "unknown";
}

export const GITHUB_HELP: Record<Exclude<GithubAccess, "ok">, (repo: string) => string> = {
  "no-app": () =>
    "the boxd GitHub App is not installed for this boxd org: an org admin installs it from Integrations in the boxd console",
  "no-repo": (repo) =>
    `the boxd GitHub App cannot read ${repo}: add the repository to its installation (Manage, on its row under Integrations in the boxd console)`,
  unknown: () => "could not ask GitHub whether the boxd GitHub App can read the repository",
};
