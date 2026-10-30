// boxd-ci doctor: is everything in place? --sweep deletes machines that finished runs left behind.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "../../boxd/sdk.js";
import { cacheAnswers, SERVER_ROOT } from "../../boxd/server.js";
import { type RepoRecord, snapshotReady } from "../../boxd/snapshot.js";
import { machineStore } from "../../boxd/store.js";
import { ciTaggedTasks } from "../../core/propose.js";
import type { RunRecord } from "../../core/record.js";
import { paths, readJson } from "../../state.js";
import type { Ctx } from "../context.js";
import { turboFiles } from "../git.js";
import { GITHUB_HELP, githubAccess } from "../setup.js";
import { ago, bold, dim, green, type Out, red, yellow } from "../ui.js";

type Check = { ok: boolean | "warn"; what: string; fix?: string };

const STALE_MS = 3 * 3600_000;

export async function doctorCommand(ctx: Ctx, flags: Record<string, string | boolean>, out: Out): Promise<number> {
  const checks: Check[] = [];
  const add = (c: Check) => {
    checks.push(c);
    if (!ctx.json) {
      const m = c.ok === true ? green("✓") : c.ok === "warn" ? yellow("!") : red("✗");
      out.line(`${m} ${c.what}${c.fix ? `\n  ${dim(c.fix)}` : ""}`);
    }
  };

  const tagged = ciTaggedTasks(turboFiles(ctx.root).map((f) => readFileSync(join(ctx.root, f), "utf8")));
  add(
    tagged.length
      ? { ok: true, what: `turbo.json tags ${tagged.join(", ")} with ci` }
      : { ok: false, what: "no task in turbo.json is tagged ci", fix: "boxd-ci init tags the usual checks" },
  );

  const boxd = connect();
  const servers = await boxd.machines
    .list({ ...(ctx.org ? { org: ctx.org } : {}), labels: { "boxd-ci": "server" } })
    .catch((e: Error) => {
      add({ ok: false, what: `boxd: ${e.message}`, fix: "sign in with boxd auth login, or set BOXD_API_KEY" });
      return null;
    });
  if (!servers) return finish(ctx, out, checks);
  add({ ok: true, what: `signed in to boxd${ctx.org ? ` (org ${ctx.org})` : ""}` });

  const server = servers.find((s) => s.name === ctx.serverName);
  if (!server) {
    add({ ok: false, what: `no server ${ctx.serverName}`, fix: "boxd-ci init (or boxd-ci run) starts it" });
    return finish(ctx, out, checks);
  }
  const store = machineStore(boxd, server.id, SERVER_ROOT);
  const info = await readJson<{ cacheUrl: string; token: string }>(store, "server.json");
  const cacheOk = info ? await cacheAnswers(info.cacheUrl, info.token) : false;
  add(
    cacheOk && info
      ? {
          ok: true,
          what: `server ${server.name} is ${server.status === "running" ? "awake" : "asleep"} and its cache answers at ${info.cacheUrl}`,
        }
      : { ok: false, what: `the cache on ${server.name} does not answer`, fix: "boxd-ci init sets it up again" },
  );

  const repo = await readJson<RepoRecord>(store, paths.repo(ctx.repo));
  if (!repo) add({ ok: false, what: `no snapshot of ${ctx.repo} yet`, fix: "boxd-ci init (or boxd-ci run) builds it" });
  else {
    const ready = await snapshotReady(boxd, repo.snapshot, ctx.org);
    add(
      ready
        ? {
            ok: true,
            what: `snapshot ${repo.snapshot}: ${repo.commit.slice(0, 7)} of ${repo.defaultBranch}, saved ${ago(repo.builtAt)}`,
          }
        : { ok: false, what: `snapshot ${repo.snapshot} cannot be restored`, fix: "boxd-ci init --rebuild" },
    );
  }

  const jobs = await boxd.machines.exec(server.id, { command: ["bash", "-c", "run jobs --json 2>/dev/null || true"] });
  const automation = jobs.stdout.includes("boxd-ci.run.ts");
  add(
    automation
      ? { ok: true, what: `the push automation is installed on ${server.name}` }
      : { ok: "warn", what: "no push automation, so pushes get no check", fix: "boxd-ci init installs it" },
  );
  if (automation) {
    const access = await githubAccess(
      boxd,
      { machineId: server.id, name: server.name, cacheUrl: "", token: "" },
      ctx.repo,
    );
    add(
      access === "ok"
        ? { ok: true, what: `the boxd GitHub App can read ${ctx.repo}` }
        : { ok: false, what: GITHUB_HELP[access](ctx.repo) },
    );
  }

  // Machines of finished runs that are still up: a controller that died, or a sweep nobody ran.
  const now = Date.now();
  const machines = await boxd.machines.list({ ...(ctx.org ? { org: ctx.org } : {}), labels: { "boxd-ci": "worker" } });
  const builders = await boxd.machines.list({ ...(ctx.org ? { org: ctx.org } : {}), labels: { "boxd-ci": "builder" } });
  const leftovers: { id: string; name: string }[] = [];
  for (const m of machines) {
    if (m.status === "standby") continue; // a failed task's machine, kept on purpose with its own timer
    const run = m.labels?.["boxd-ci/run"];
    const slug = m.labels?.["boxd-ci/repo"];
    const record = run && slug ? await readJson<RunRecord>(store, `runs/${slug}/${run}.json`) : null;
    const age = m.createdAt ? now - m.createdAt.getTime() : 0;
    if ((record && record.status !== "running") || age > STALE_MS) leftovers.push(m);
  }
  for (const b of builders) if (b.createdAt && now - b.createdAt.getTime() > STALE_MS) leftovers.push(b);
  if (!leftovers.length) add({ ok: true, what: "no machine of a finished run is left running" });
  else if (flags.sweep) {
    await Promise.all(leftovers.map((m) => boxd.machines.delete(m.id).catch(() => {})));
    add({
      ok: true,
      what: `deleted ${leftovers.length} machines finished runs left behind: ${leftovers.map((m) => m.name).join(", ")}`,
    });
  } else {
    add({
      ok: "warn",
      what: `${leftovers.length} machines of finished runs are still running: ${leftovers.map((m) => m.name).join(", ")}`,
      fix: "boxd-ci doctor --sweep deletes them",
    });
  }
  return finish(ctx, out, checks);
}

function finish(ctx: Ctx, out: Out, checks: Check[]): number {
  const bad = checks.some((c) => c.ok === false);
  if (ctx.json) out.json({ ok: !bad, checks });
  else if (!bad) out.line(`\n${bold("All good.")}`);
  return bad ? 1 : 0;
}
