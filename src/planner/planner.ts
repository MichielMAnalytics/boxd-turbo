// The planner runs on a machine restored from the snapshot, inside the repository: it finds the
// workspaces, resolves which tasks are tagged ci, and asks Turborepo for the graph of those tasks
// and what the cache already has. It prints the plan as JSON for the controller to schedule.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { CONFIG_FILE, type Config, parseConfig } from "../core/config.js";
import type { TurboDryRun } from "../core/graph.js";
import { type CiTask, resolveCiTasks, type Workspace } from "../core/tags.js";

export type Plan = {
  version: 1;
  turboVersion: string;
  selectors: CiTask[];
  warnings: string[];
  /** The run settings from .boxd-ci.json (org and server stay with the CLI). */
  config: Pick<Config, "maxMachines" | "packSeconds">;
  dry: TurboDryRun;
};

export type PlanOptions = {
  cwd: string;
  /** The turbo binary. Default: the repository's own, node_modules/.bin/turbo. */
  turbo?: string;
  env?: NodeJS.ProcessEnv;
  /** Reads the root turbo.json (tests replace it). */
  readTurboJson?: (cwd: string) => unknown;
};

const run = (cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) =>
  new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { cwd, env: env ?? process.env, maxBuffer: 1024 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${[cmd, ...args].join(" ")} failed: ${stderr.trim() || err.message}`));
      else resolve(stdout);
    });
  });

/** Turborepo prints a banner line before its JSON on some commands. */
const jsonAfterBanner = (s: string): unknown => JSON.parse(s.slice(s.indexOf("{")));

const readJsonc = (file: string): unknown => (existsSync(file) ? parse(readFileSync(file, "utf8")) : undefined);
const scriptsOf = (dir: string): string[] => {
  const pkg = readJsonc(join(dir, "package.json")) as { scripts?: Record<string, string> } | undefined;
  return Object.keys(pkg?.scripts ?? {});
};
const rootTurboJson = (cwd: string) => readJsonc(join(cwd, "turbo.json")) ?? readJsonc(join(cwd, "turbo.jsonc"));

export async function plan(o: PlanOptions): Promise<Plan> {
  const turbo = o.turbo ?? join(o.cwd, "node_modules", ".bin", "turbo");
  if (!existsSync(turbo)) throw new Error("turbo is not installed in this repository: add it as a devDependency");

  const ls = jsonAfterBanner(await run(turbo, ["ls", "--output=json"], o.cwd, o.env)) as {
    packages?: { items?: { name: string; path: string }[] };
  };
  const workspaces: Workspace[] = [{ name: "//", dir: ".", scripts: scriptsOf(o.cwd) }];
  for (const item of ls.packages?.items ?? []) {
    const dir = join(o.cwd, item.path);
    workspaces.push({
      name: item.name,
      dir: item.path,
      scripts: scriptsOf(dir),
      turboJson: readJsonc(join(dir, "turbo.json")) ?? readJsonc(join(dir, "turbo.jsonc")),
    });
  }

  const configFile = join(o.cwd, CONFIG_FILE);
  const parsed = parseConfig(existsSync(configFile) ? readFileSync(configFile, "utf8") : undefined);
  const config = { maxMachines: parsed.config.maxMachines, packSeconds: parsed.config.packSeconds };
  const resolved = resolveCiTasks((o.readTurboJson ?? rootTurboJson)(o.cwd), workspaces);
  const tasks = resolved.tasks;
  const warnings = [...parsed.warnings, ...resolved.warnings];
  if (tasks.length === 0) {
    const version = (await run(turbo, ["--version"], o.cwd, o.env)).trim();
    return {
      version: 1,
      turboVersion: version,
      selectors: [],
      warnings: [...warnings, "no task is tagged ci in turbo.json, so there is nothing to run"],
      config,
      dry: { tasks: [] },
    };
  }

  const dryArgs = ["run", ...tasks.map((t) => t.selector), "--dry=json", "--cache=local:r,remote:r"];
  const dry = jsonAfterBanner(await run(turbo, dryArgs, o.cwd, o.env)) as TurboDryRun & { turboVersion: string };
  return {
    version: 1,
    turboVersion: dry.turboVersion,
    selectors: tasks,
    warnings,
    config,
    dry: {
      tasks: dry.tasks.map((t) => ({
        taskId: t.taskId,
        task: t.task,
        package: t.package,
        directory: t.directory,
        hash: t.hash,
        cache: { status: t.cache.status },
        dependencies: t.dependencies,
        outputs: t.outputs,
        command: t.command,
        ...(t.logFile ? { logFile: t.logFile } : {}),
      })),
    },
  };
}
