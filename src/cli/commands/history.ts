// boxd-ci ls, logs and grep: the runs of this repository, as the server keeps them.

import { q } from "../../boxd/scripts.js";
import { connect } from "../../boxd/sdk.js";
import { SERVER_ROOT } from "../../boxd/server.js";
import { repoSlug } from "../../boxd/snapshot.js";
import { type RunRecord, runSeconds } from "../../core/record.js";
import { formatSeconds, terminalSummary } from "../../core/report.js";
import { paths, readJson } from "../../state.js";
import { type Ctx, openServer } from "../context.js";
import { ago, bold, dim, green, type Out, red, yellow } from "../ui.js";

const RUN_FILE = /^\d{8}-\d{6}-[0-9a-f]{7}\.json$/;

async function runIds(ctx: Ctx) {
  const boxd = connect();
  const { server, store } = await openServer(ctx, boxd);
  const ids = (await store.list(paths.runs(ctx.repo))).filter((n) => RUN_FILE.test(n)).map((n) => n.slice(0, -5));
  return { boxd, server, store, ids };
}

const mark = (r: RunRecord) => (r.status === "success" ? green("✓") : r.status === "failure" ? red("✗") : yellow("…"));

function verdict(r: RunRecord): string {
  const failed = r.results.filter((t) => t.status === "failed").length;
  if (r.status === "running") return yellow("running");
  if (r.status === "success") return green("green");
  return red(failed ? `${failed} failed` : "error");
}

export async function lsCommand(ctx: Ctx, flags: Record<string, string | boolean>, out: Out): Promise<number> {
  const limit = Number(flags.limit ?? 15);
  const { store, ids } = await runIds(ctx);
  const chosen = ids.slice(-limit).reverse();
  const records = (await store.readMany(chosen.map((id) => paths.run(ctx.repo, id))))
    .map((t) => (t ? (JSON.parse(t) as RunRecord) : null))
    .filter((r): r is RunRecord => r !== null);
  if (ctx.json) {
    out.json(records.map(({ results, ...r }) => ({ ...r, tasks: count(results) })));
    return 0;
  }
  if (!records.length) {
    out.line(`no runs of ${ctx.repo} yet: ${bold("boxd-ci run")} starts one`);
    return 0;
  }
  for (const r of records) {
    const c = count(r.results);
    const time = r.status === "running" ? ago(r.startedAt) : formatSeconds(runSeconds(r));
    const where = `${r.ref.length > 20 ? `${r.ref.slice(0, 19)}…` : r.ref}`.padEnd(20);
    const how = (r.trigger === "local" ? "local" : "push").padEnd(5);
    const counts = `${c.ran} ran · ${c.restored} restored${c.skipped ? ` · ${c.skipped} skipped` : ""} · ${r.machines} machines`;
    out.line(`${mark(r)} ${r.id}  ${where} ${how} ${time.padStart(7)}  ${verdict(r)}  ${dim(counts)}`);
    if (r.error) out.line(`  ${dim(r.error.split("\n")[0]?.slice(0, 110) ?? "")}`);
  }
  return 0;
}

const count = (results: RunRecord["results"]) => ({
  ran: results.filter((t) => t.status === "ran").length,
  restored: results.filter((t) => t.status === "restored").length,
  failed: results.filter((t) => t.status === "failed").length,
  skipped: results.filter((t) => t.status === "skipped").length,
});

export async function logsCommand(ctx: Ctx, args: string[], flags: Record<string, string | boolean>, out: Out) {
  const { store, ids } = await runIds(ctx);
  const want = args[0];
  const id = want ? ids.filter((i) => i.startsWith(want) || i.endsWith(want)).at(-1) : ids.at(-1);
  if (!id)
    throw new Error(want ? `no run of ${ctx.repo} matches ${want}: see boxd-ci ls` : `no runs of ${ctx.repo} yet`);
  const record = await readJson<RunRecord>(store, paths.run(ctx.repo, id));
  if (!record) throw new Error(`run ${id} has no record`);
  const logs = (await readJson<Record<string, string>>(store, paths.logs(ctx.repo, id))) ?? {};
  const task = flags.task as string | undefined;
  const failed = record.results.filter((r) => r.status === "failed");
  const chosen = task ? [task] : flags.failed || failed.length ? failed.map((r) => r.id) : [];
  const text = (t: string) => logs[t] ?? record.results.find((r) => r.id === t)?.logTail ?? "";
  if (task && !record.results.some((r) => r.id === task)) throw new Error(`run ${id} has no task ${task}`);

  if (ctx.json) {
    out.json({ ...record, logs: Object.fromEntries(chosen.map((t) => [t, text(t)])) });
    return 0;
  }
  if (!task) out.line(terminalSummary(record));
  for (const t of chosen) {
    out.line();
    out.line(bold(`── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`));
    out.line(text(t) || dim("(no output)"));
  }
  if (!task && !chosen.length) out.line(dim(`\n--task <id> prints one task's log`));
  return 0;
}

export async function grepCommand(ctx: Ctx, args: string[], flags: Record<string, string | boolean>, out: Out) {
  const needle = args.join(" ");
  if (!needle) throw new Error("grep needs the text to look for: boxd-ci grep <text>");
  const runs = Number(flags.runs ?? 20);
  const boxd = connect();
  const { server } = await openServer(ctx, boxd);
  // Searched on the server, so only the matching lines travel.
  const js = `const fs=require("fs"),p=require("path");const [dir,needle,n]=process.argv.slice(1);
let files=[];try{files=fs.readdirSync(dir).filter(f=>f.endsWith(".logs.json")).sort().slice(-Number(n))}catch{}
const hits=[];for(const f of files.reverse()){let logs={};try{logs=JSON.parse(fs.readFileSync(p.join(dir,f),"utf8"))}catch{continue}
for(const [task,log] of Object.entries(logs)){for(const line of String(log).split("\\n")){if(line.includes(needle)){hits.push({run:f.slice(0,-10),task,line:line.slice(0,400)});if(hits.length>=300)break}}}}
process.stdout.write(JSON.stringify(hits))`;
  const dir = `${SERVER_ROOT}/runs/${repoSlug(ctx.repo)}`;
  const res = await boxd.machines.exec(server.machineId, {
    command: ["node", "-e", js, dir, needle, String(runs)],
    timeout: 120_000,
  });
  const hits = JSON.parse(res.stdout || "[]") as { run: string; task: string; line: string }[];
  if (ctx.json) {
    out.json(hits);
    return hits.length ? 0 : 1;
  }
  for (const h of hits) out.line(`${dim(h.run)} ${bold(h.task)}  ${h.line.replaceAll(needle, red(needle))}`);
  if (!hits.length) out.line(dim(`no line of the last ${runs} runs' logs contains ${q(needle)}`));
  return hits.length ? 0 : 1;
}
