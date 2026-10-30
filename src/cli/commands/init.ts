// boxd-ci init: tag the ci tasks, start the server, build the snapshot, install the push automation.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import { connect } from "../../boxd/sdk.js";
import { CONFIG_FILE } from "../../core/config.js";
import { ciTaggedTasks, proposeCiTags } from "../../core/propose.js";
import { paths, readJson } from "../../state.js";
import { type Ctx, openServer } from "../context.js";
import { turboFiles } from "../git.js";
import { ensureRepoRecord, GITHUB_HELP, githubAccess, installAutomation } from "../setup.js";
import { bold, clock, dim, green, type Out, yellow } from "../ui.js";

export type InitFacts = {
  repo: string;
  org?: string;
  server: string;
  hasServer: boolean;
  hasSnapshot: boolean;
  tagged: string[];
  github: boolean;
  writeConfig?: boolean;
};

/** What init will do, in order: the --dry-run output, and the outline of a real run. */
export function initPlan(f: InitFacts): string[] {
  const steps: string[] = [];
  if (f.tagged.length) steps.push(`tag ${f.tagged.join(", ")} with ci in turbo.json`);
  if (f.org && f.writeConfig !== false) steps.push(`write ${CONFIG_FILE} (org ${f.org})`);
  if (!f.hasServer) steps.push(`start ${f.server}${f.org ? ` in ${f.org}` : ""}: the Turborepo cache and run history`);
  if (!f.hasSnapshot) steps.push(`build the first snapshot of ${f.repo} from its default branch`);
  if (f.github) {
    steps.push(`install the push automation on ${f.server} and check the boxd GitHub App can read ${f.repo}`);
  }
  return steps;
}

const turboFile = (root: string) => ["turbo.json", "turbo.jsonc"].map((f) => join(root, f)).find((f) => existsSync(f));

export async function initCommand(ctx: Ctx, flags: Record<string, string | boolean>, out: Out): Promise<number> {
  const turbo = turboFile(ctx.root);
  if (!turbo) throw new Error(`no turbo.json in ${ctx.root}. boxd-ci runs the tasks of a Turborepo monorepo.`);
  const tagged = ciTaggedTasks(turboFiles(ctx.root).map((f) => readFileSync(join(ctx.root, f), "utf8")));
  const proposal = tagged.length ? { text: "", tagged: [] } : proposeCiTags(readFileSync(turbo, "utf8"));
  const configPath = join(ctx.root, CONFIG_FILE);
  const writeConfig = !!ctx.org && ctx.config.org !== ctx.org;
  const github = flags["no-github"] !== true;

  if (flags["dry-run"]) {
    const steps = initPlan({
      repo: ctx.repo,
      ...(ctx.org ? { org: ctx.org } : {}),
      server: ctx.serverName,
      hasServer: false,
      hasSnapshot: false,
      tagged: proposal.tagged,
      github,
      writeConfig,
    });
    if (ctx.json) out.json({ steps });
    else {
      out.line(`boxd-ci init would, for ${bold(ctx.repo)}:`);
      for (const s of steps) out.line(`  · ${s}`);
      out.line(dim("Steps that are already done are skipped."));
    }
    return 0;
  }

  const say = ctx.json ? () => {} : clock(out);
  if (proposal.tagged.length) {
    writeFileSync(turbo, proposal.text);
    say(`tagged ${proposal.tagged.join(", ")} with ci in turbo.json. Commit and push it.`);
  }
  if (writeConfig) {
    const text = existsSync(configPath) ? readFileSync(configPath, "utf8") : "{}\n";
    writeFileSync(
      configPath,
      applyEdits(text, modify(text, ["org"], ctx.org, { formattingOptions: { insertSpaces: true, tabSize: 2 } })),
    );
    say(`wrote ${CONFIG_FILE}. Commit it, so everyone's boxd-ci uses org ${ctx.org}.`);
  }

  const boxd = connect();
  const { server, store } = await openServer(ctx, boxd, say);
  say(`server ${server.name}, cache at ${server.cacheUrl}`);
  const had = await readJson(store, paths.repo(ctx.repo));
  const record = await ensureRepoRecord(ctx, boxd, server, store, say, { rebuild: flags.rebuild === true });

  let access: string = "skipped";
  if (github) {
    await installAutomation(boxd, server, say);
    access = await githubAccess(boxd, server, ctx.repo);
    if (access === "ok") say(green(`the boxd GitHub App can read ${ctx.repo}, so every push gets a boxd-ci check`));
    else say(yellow(GITHUB_HELP[access as keyof typeof GITHUB_HELP](ctx.repo)));
  }

  if (ctx.json) {
    out.json({
      repo: ctx.repo,
      server: server.name,
      cacheUrl: server.cacheUrl,
      snapshot: record,
      rebuilt: !!had && flags.rebuild === true,
      github: access,
    });
    return 0;
  }
  out.line();
  out.line(
    `${green("✓")} ${bold(ctx.repo)} is set up on boxd. Runs start from ${record.snapshot} (${record.commit.slice(0, 7)}).`,
  );
  out.line(`  ${bold("boxd-ci run")}   CI on your working copy, now`);
  if (github && access === "ok") out.line(`  ${bold("git push")}      the boxd-ci check appears on the commit`);
  return 0;
}
