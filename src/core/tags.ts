// Which Turborepo tasks run in CI, read from the same `tags` Vercel CI uses, so a repo set up for
// Vercel CI works unchanged:
//
//   ci                  run this task in CI
//   !ci                 never run it (wins over ci)
//   ci:cpus:N           the machine size for it (boxd sizes: 1, 2, 4 or 8 vCPU)
//   ci:os:*             accepted and ignored (boxd machines are Ubuntu)
//   $TURBO_EXTENDS$     first entry of a package's task tags: keep the root's tags and add these
//
// A repository without a single ci tag runs the usual checks its turbo.json defines (lint, type
// checks, tests), so boxd-turbo works before anyone tags anything, on any Turborepo version it supports.
// Tasks that need a Vercel deployment or Vercel's OIDC tokens are left out, with a warning.
//
// Turborepo resolves its own configuration, but its dry run does not report tags, so they are
// resolved here from the root turbo.json and each package's turbo.json.

export type Workspace = {
  /** The package name, or "//" for the repository root. */
  name: string;
  dir: string;
  /** The package.json script names: a task only runs where its script exists. */
  scripts: string[];
  /** The package's own turbo.json, parsed, if it has one. */
  turboJson?: unknown;
};

export type CiTask = { selector: string; cpus?: number };

/** What runs in a repository that tags nothing ci, where turbo.json defines it. */
export const USUAL_CHECKS = ["lint", "type-check", "typecheck", "check-types", "types", "test", "test:unit"];

const EXTENDS = "$TURBO_EXTENDS$";
const SIZES = [1, 2, 4, 8];

type TaskDef = { tags?: unknown; dependsOn?: unknown };
type TurboJson = { tags?: unknown; tasks?: Record<string, TaskDef | undefined> };

const asConfig = (v: unknown): TurboJson => (v && typeof v === "object" ? (v as TurboJson) : {});
const tagsOf = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : undefined;

/** The task names tagged ci anywhere: the root turbo.json, or a package's (its tasks or its top-level tags). */
function ciTagged(root: TurboJson, workspaces: Workspace[]): string[] {
  const names = new Set<string>();
  const scan = (tasks: TurboJson["tasks"], all: boolean) => {
    for (const [name, def] of Object.entries(tasks ?? {})) {
      if (all || tagsOf(def?.tags)?.includes("ci")) names.add(name.slice(name.indexOf("#") + 1));
    }
  };
  scan(root.tasks, false);
  for (const ws of workspaces) {
    const pkg = asConfig(ws.turboJson);
    scan(pkg.tasks, !!tagsOf(pkg.tags)?.includes("ci"));
  }
  return [...names].sort();
}

/** A dependsOn entry on a Vercel deployment (`web#deployment`, `^deployment`), if the task has one. */
const deploymentDep = (...defs: (TaskDef | undefined)[]): string | undefined =>
  defs
    .flatMap((d) => (Array.isArray(d?.dependsOn) ? d.dependsOn : []))
    .find((x): x is string => typeof x === "string" && x.replace(/^\^/, "").split("#").at(-1) === "deployment");

export function resolveCiTasks(
  rootTurboJson: unknown,
  workspaces: Workspace[],
): { tasks: CiTask[]; warnings: string[]; nothingToRun?: string } {
  const root = asConfig(rootTurboJson);
  const rootTasks = root.tasks ?? {};
  // A repository whose only workspace is the root runs in Turborepo's single-package mode, where
  // tasks are plain names and `//#` selectors are refused.
  const singlePackage = workspaces.every((w) => w.name === "//");
  const tagged = ciTagged(root, workspaces);
  const usual = tagged.length === 0;
  const tasks: CiTask[] = [];
  const warnings: string[] = [];

  for (const ws of workspaces) {
    const isRoot = ws.name === "//";
    const pkg = asConfig(ws.turboJson);
    for (const script of ws.scripts) {
      const rootDef = isRoot
        ? (rootTasks[`//#${script}`] ?? (singlePackage ? rootTasks[script] : undefined))
        : (rootTasks[`${ws.name}#${script}`] ?? rootTasks[script]);
      const pkgTags = isRoot ? undefined : tagsOf(pkg.tasks?.[script]?.tags);
      const rootTags = tagsOf(rootDef?.tags) ?? [];
      const taskTags =
        pkgTags === undefined ? rootTags : pkgTags[0] === EXTENDS ? [...rootTags, ...pkgTags.slice(1)] : pkgTags;
      // A package's top-level tags are defaults for every task in it; the task's own wins per kind.
      const defaults = isRoot ? [] : (tagsOf(pkg.tags) ?? []);
      const tags = [
        ...defaults.filter((d) => !(d.startsWith("ci:cpus:") && taskTags.some((t) => t.startsWith("ci:cpus:")))),
        ...taskTags,
      ];
      if (tags.includes("!ci")) continue;
      const pkgDef = isRoot ? undefined : pkg.tasks?.[script];
      if (usual ? !USUAL_CHECKS.includes(script) || !(rootDef || pkgDef) : !tags.includes("ci")) continue;

      const selector = singlePackage ? script : `${ws.name}#${script}`;
      const dep = deploymentDep(rootDef, pkgDef);
      const oidc = tags.find((t) => t.startsWith("ci:oidc:"));
      if (dep) {
        warnings.push(
          `${selector} depends on a Vercel deployment (${dep}), which boxd-turbo does not make, so it does not run`,
        );
        continue;
      }
      if (oidc) {
        warnings.push(
          `${selector} asks for Vercel OIDC tokens (${oidc}), which boxd-turbo does not have, so it does not run`,
        );
        continue;
      }
      const task: CiTask = { selector };
      const asked = tags.filter((t) => t.startsWith("ci:cpus:")).at(-1);
      if (asked) {
        const n = Number(asked.slice("ci:cpus:".length));
        if (Number.isFinite(n) && n > 0) {
          const size = SIZES.find((s) => s >= n);
          if (size === undefined)
            warnings.push(`${selector} asks for ${n} CPUs and boxd's largest machine has 8, so it runs on 8`);
          task.cpus = size ?? 8;
        } else {
          warnings.push(`${selector} has an unreadable tag ${asked}, so it runs on the default size`);
        }
      }
      tasks.push(task);
    }
  }

  tasks.sort((a, b) => (a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0));
  warnings.sort();
  const scripts = [...new Set(tasks.map((t) => t.selector.split("#").at(-1) as string))];
  if (usual && tasks.length) {
    warnings.unshift(`no task in turbo.json is tagged ci, so boxd-turbo runs the usual checks: ${scripts.join(", ")}`);
  }
  if (tasks.length) return { tasks, warnings };
  const nothingToRun = usual
    ? `nothing to run. No task in turbo.json is tagged ci, and it defines none of ${USUAL_CHECKS.slice(0, -1).join(", ")} or ${USUAL_CHECKS.at(-1)}.`
    : `nothing to run. No package has a script for the tasks tagged ci (${tagged.join(", ")}).`;
  return { tasks, warnings, nothingToRun };
}
