// boxd-ci run: CI on the working copy, now. The working copy goes up as one patch on the snapshot's
// commit; every ci task runs on its own machine; failed machines stay for a day.

import { connect } from "../../boxd/sdk.js";
import { createPool } from "../../boxd/worker.js";
import { formatSeconds, keptMachines, terminalSummary } from "../../core/report.js";
import { runPipeline } from "../../pipeline.js";
import { bundled, type Ctx, openServer, requireTurboJson } from "../context.js";
import { currentBranch, ensureCommit, makePatch } from "../git.js";
import { ensureRepoRecord } from "../setup.js";
import { bold, clock, dim, green, type Out, red, runPrinter, yellow } from "../ui.js";

const MAX_PATCH_BYTES = 100 * 1024 * 1024;

export async function runCommand(ctx: Ctx, flags: Record<string, string | boolean>, out: Out): Promise<number> {
  const maxMachines = flags["max-machines"] === undefined ? undefined : Number(flags["max-machines"]);
  if (maxMachines !== undefined && !(Number.isInteger(maxMachines) && maxMachines >= 1)) {
    throw new Error("--max-machines takes a whole number of at least 1");
  }
  requireTurboJson(ctx.root);
  const say = ctx.json ? () => {} : clock(out);
  for (const w of ctx.warnings) say(yellow(w));

  const boxd = connect();
  const { server, store } = await openServer(ctx, boxd, say);
  const repo = await ensureRepoRecord(ctx, boxd, server, store, say);

  ensureCommit(ctx.root, repo.commit);
  const patch = makePatch(ctx.root, repo.commit);
  if (patch.length > MAX_PATCH_BYTES) {
    throw new Error(
      `your working copy differs from the snapshot's commit by ${Math.round(patch.length / 1048576)} MB. Ignore or commit large files first.`,
    );
  }
  const ref = currentBranch(ctx.root);
  say(
    `your working copy (${ref}) on ${repo.commit.slice(0, 7)}: ${patch.length ? `a ${Math.ceil(patch.length / 1024)} kB patch` : "no changes"}`,
  );

  // Ctrl-C stops the run and deletes its machines; a second Ctrl-C leaves at once (timers delete them).
  const stop = new AbortController();
  const onInt = () => {
    if (stop.signal.aborted) process.exit(130);
    say(yellow("stopping, and deleting the run's machines (Ctrl-C again to leave now)"));
    stop.abort();
  };
  process.on("SIGINT", onInt);
  try {
    const record = await runPipeline(
      {
        boxd,
        store,
        cache: { url: server.cacheUrl, token: server.token },
        ...(ctx.org ? { org: ctx.org } : {}),
        plannerBundle: bundled("planner.mjs"),
        pool: (o) => createPool(boxd, o),
        ...(maxMachines ? { maxMachines } : {}),
        signal: stop.signal,
        onEvent: runPrinter(say),
      },
      {
        repo,
        trigger: "local",
        sha: repo.commit,
        ref,
        prepare: { kind: "patch", base: repo.commit, patch },
        ...(ctx.config.secrets?.length ? { secrets: ctx.config.secrets } : {}),
      },
    );
    if (ctx.json) {
      out.json(record);
      return record.status === "success" ? 0 : 1;
    }
    out.line();
    out.line(
      terminalSummary(record)
        .replace(/^green/m, green("green"))
        .replace(/^failed/m, red("failed")),
    );
    if (record.error) out.line(red(record.error));
    for (const w of record.warnings) out.line(yellow(`! ${w}`));
    const kept = keptMachines(record);
    if (kept.length) {
      out.line();
      out.line(
        kept.length === 1
          ? "This machine is kept for 24 hours, as the failed task left it:"
          : "These machines are kept for 24 hours, as the failed tasks left them:",
      );
      for (const k of kept) out.line(`  ${bold(`boxd connect ${k}`)}`);
      out.line(dim(`  boxd-ci logs ${record.id} --failed   the end of each failed log`));
    }
    out.line(
      dim(
        `run ${record.id} · ${formatSeconds((Date.parse(record.finishedAt ?? "") - Date.parse(record.startedAt)) / 1000)} · boxd-ci ls`,
      ),
    );
    return record.status === "success" ? 0 : 1;
  } finally {
    process.off("SIGINT", onInt);
  }
}
