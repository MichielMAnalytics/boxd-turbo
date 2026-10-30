// The benchmark: one scenario push after another on a clone of the benchmark repository, each
// measured from the end of `git push` to the boxd-ci check's completion on GitHub, the way the
// Vercel CI lane was measured. One line per push goes to bench/results/boxd-ci.jsonl.
//
//   npx tsx bench/push.ts <clone> <scenario>:<warmups>:<measured> ...
//   npx tsx bench/push.ts ../bench-ai docs:1:3 leaf:1:3 core:1:3
//
// Scenarios append a comment with a fresh nonce to one file, so exactly that file changes:
//   docs  content/docs/00-introduction/index.mdx   (no task reads it)
//   leaf  packages/mistral/src/index.ts             (one provider package)
//   core  packages/provider-utils/src/index.ts      (a package most others build on)

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FILES = {
  docs: "content/docs/00-introduction/index.mdx",
  leaf: "packages/mistral/src/index.ts",
  core: "packages/provider-utils/src/index.ts",
} as const;
type Scenario = keyof typeof FILES;

const here = fileURLToPath(new URL(".", import.meta.url));
const out = join(here, "results", "boxd-ci.jsonl");
const cli = resolve(here, "..", "dist", "cli.mjs");

const sh = (cwd: string, cmd: string, args: string[]) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function push(clone: string, scenario: Scenario, role: "warmup" | "measured") {
  const branch = `bench-${scenario}`;
  const exists = sh(clone, "git", ["ls-remote", "origin", `refs/heads/${branch}`]) !== "";
  sh(clone, "git", ["checkout", "-q", "-B", branch, exists ? `origin/${branch}` : "origin/main"]);
  const nonce = new Date().toISOString();
  const file = join(clone, FILES[scenario]);
  const line = scenario === "docs" ? `\n{/* bench: ${nonce} */}\n` : `// bench: ${nonce}\n`;
  appendFileSync(file, line);
  sh(clone, "git", [
    "-c",
    "user.name=boxd-bench",
    "-c",
    "user.email=bench@boxd.sh",
    "commit",
    "-qam",
    `bench: ${scenario} ${role} ${nonce}`,
  ]);
  const sha = sh(clone, "git", ["rev-parse", "HEAD"]);
  sh(clone, "git", ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
  const pushedAt = Date.now() / 1000;
  sh(clone, "git", ["fetch", "-q", "origin", branch]);

  const repo = sh(clone, "gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  type Check = { name: string; status: string; conclusion: string; completed_at: string; output: { title: string } };
  let check: Check | undefined;
  while (!check) {
    await sleep(3000);
    const runs = JSON.parse(sh(clone, "gh", ["api", `repos/${repo}/commits/${sha}/check-runs`])) as {
      check_runs: Check[];
    };
    check = runs.check_runs.find((c) => c.name === "boxd-ci" && c.status === "completed");
  }
  // The run's own record: tasks, machines and machine time, from the server.
  type Run = { sha: string; results: { status: string }[]; machines: number; machineSeconds?: Record<string, number> };
  const runs = JSON.parse(sh(clone, "node", [cli, "ls", "--json", "--limit", "30"])) as (Run & {
    tasks: Record<string, number>;
  })[];
  const run = runs.find((r) => r.sha === sha);
  const row = {
    platform: "boxd-ci",
    scenario,
    role,
    sha,
    branch,
    result: check.conclusion,
    wall_s: Math.round((Date.parse(check.completed_at) / 1000 - pushedAt) * 10) / 10,
    title: check.output.title,
    ...(run ? { tasks: run.tasks, machines: run.machines, machineSeconds: run.machineSeconds } : {}),
    at: new Date().toISOString(),
  };
  appendFileSync(out, `${JSON.stringify(row)}\n`);
  console.log(`${scenario} ${role} ${row.result} ${row.wall_s}s  ${row.title}`);
}

const [clone, ...plan] = process.argv.slice(2);
if (!clone || !plan.length) {
  console.error(
    readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .slice(0, 12)
      .join("\n"),
  );
  process.exit(1);
}
for (const step of plan) {
  const [scenario, warmups = "1", measured = "3"] = step.split(":") as [Scenario, string, string];
  if (!(scenario in FILES)) throw new Error(`unknown scenario ${scenario}: docs, leaf or core`);
  for (let i = 0; i < Number(warmups); i++) await push(resolve(clone), scenario, "warmup");
  for (let i = 0; i < Number(measured); i++) await push(resolve(clone), scenario, "measured");
}
