// boxd-turbo doctor: is everything in place? --sweep deletes machines that finished runs left behind.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "../../boxd/sdk.js";
import { cacheAnswers, SERVER_ROOT } from "../../boxd/server.js";
import { type RepoRecord, snapshotReady } from "../../boxd/snapshot.js";
import { machineStore } from "../../boxd/store.js";
import { ciTaggedTasks, ownConfigs, usualChecks } from "../../core/ci-tasks.js";
import type { RunRecord } from "../../core/record.js";
import { leftovers } from "../../core/sweep.js";
import { paths, readJson } from "../../state.js";
import type { Ctx } from "../context.js";
import { turboFiles } from "../git.js";
import { GITHUB_HELP, githubAccess } from "../setup.js";
import { ago, bold, dim, green, type Out, red, yellow } from "../ui.js";

type Check = { ok: boolean | "warn"; what: string; fix?: string };

export async function doctorCommand(ctx: Ctx, flags: Record<string, string | boolean>, out: Out): Promise<number> {
  const checks: Check[] = [];
  const add = (c: Check) => {
    checks.push(c);
    if (!ctx.json) {
      const m = c.ok === true ? green("✓") : c.ok === "warn" ? yellow("!") : red("✗");
      out.line(`${m} ${c.what}${c.fix ? `\n  ${dim(c.fix)}` : ""}`);
    }
  };

  const texts = ownConfigs(
    turboFiles(ctx.root).map((path) => ({ path, text: readFileSync(join(ctx.root, path), "utf8") })),
  );
  const tagged = ciTaggedTasks(texts);
  const usual = tagged.length ? [] : usualChecks(texts);
  add(
    tagged.length
      ? { ok: true, what: `turbo.json tags ${tagged.join(", ")} with ci` }
      : usual.length
        ? { ok: true, what: `no task in turbo.json is tagged ci, so CI runs the usual checks: ${usual.join(", ")}` }
        : {
            ok: false,
            what: "no task in turbo.json is tagged ci, and it defines none of the usual checks",
            fix: "tag the tasks CI should run with ci (turbo 2.11 or newer)",
          },
  );

  const boxd = connect();
  const servers = await boxd.machines
    .list({ ...(ctx.org ? { org: ctx.org } : {}), labels: { "boxd-turbo": "server" } })
    .catch((e: Error) => {
      add({ ok: false, what: `boxd: ${e.message}`, fix: "sign in with boxd auth login, or set BOXD_API_KEY" });
      return null;
    });
  if (!servers) return finish(ctx, out, checks);
  add({ ok: true, what: `signed in to boxd${ctx.org ? ` (org ${ctx.org})` : ""}` });

  const server = servers.find((s) => s.name === ctx.serverName);
  if (!server) {
    add({ ok: false, what: `no server ${ctx.serverName}`, fix: "boxd-turbo init (or boxd-turbo run) starts it" });
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
      : { ok: false, what: `the cache on ${server.name} does not answer`, fix: "boxd-turbo init sets it up again" },
  );

  const repo = await readJson<RepoRecord>(store, paths.repo(ctx.repo));
  if (!repo)
    add({ ok: false, what: `no snapshot of ${ctx.repo} yet`, fix: "boxd-turbo init (or boxd-turbo run) builds it" });
  else {
    const ready = await snapshotReady(boxd, repo.snapshot, ctx.org);
    add(
      ready
        ? {
            ok: true,
            what: `snapshot ${repo.snapshot}: ${repo.commit.slice(0, 7)} of ${repo.defaultBranch}, saved ${ago(repo.builtAt)}`,
          }
        : { ok: false, what: `snapshot ${repo.snapshot} cannot be restored`, fix: "boxd-turbo init --rebuild" },
    );
  }

  const jobs = await boxd.machines.exec(server.id, { command: ["bash", "-c", "run jobs --json 2>/dev/null || true"] });
  const automation = jobs.stdout.includes("boxd-turbo.run.ts");
  add(
    automation
      ? { ok: true, what: `the push automation is installed on ${server.name}` }
      : { ok: "warn", what: "no push automation, so pushes get no check", fix: "boxd-turbo init installs it" },
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
  const scope = ctx.org ? { org: ctx.org } : {};
  const machines = [
    ...(await boxd.machines.list({ ...scope, labels: { "boxd-turbo": "worker" } })),
    ...(await boxd.machines.list({ ...scope, labels: { "boxd-turbo": "builder" } })),
  ];
  const asked = [
    ...new Set(
      machines
        .filter((m) => m.status === "running" && m.labels?.["boxd-turbo/run"] && m.labels?.["boxd-turbo/repo"])
        .map((m) => `runs/${m.labels?.["boxd-turbo/repo"]}/${m.labels?.["boxd-turbo/run"]}.json`),
    ),
  ];
  const statuses = new Map<string, string>();
  (await store.readMany(asked)).forEach((text, i) => {
    if (!text) return;
    try {
      statuses.set(asked[i] as string, (JSON.parse(text) as RunRecord).status);
    } catch {
      // an unreadable record says nothing about the run
    }
  });
  const left = leftovers(machines, (repo, run) => statuses.get(`runs/${repo}/${run}.json`));
  if (!left.length) add({ ok: true, what: "no machine of a finished run is left running" });
  else if (flags.sweep) {
    const done = await Promise.allSettled(left.map((m) => boxd.machines.delete(m.id)));
    const deleted = left.filter((_, i) => done[i]?.status === "fulfilled").map((m) => m.name);
    const stuck = left.filter((_, i) => done[i]?.status === "rejected").map((m) => m.name);
    if (deleted.length)
      add({ ok: true, what: `deleted ${deleted.length} machines finished runs left behind: ${deleted.join(", ")}` });
    if (stuck.length) {
      add({ ok: false, what: `could not delete ${stuck.join(", ")}`, fix: "boxd-turbo doctor --sweep tries again" });
    }
  } else {
    add({
      ok: "warn",
      what: `${left.length} machines of finished runs are still running: ${left.map((m) => m.name).join(", ")}`,
      fix: "boxd-turbo doctor --sweep deletes them",
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
