// Which Turborepo tasks run in CI, read from the same `tags` Vercel CI uses, so a repo set up for
// Vercel CI works unchanged:
//
//   ci                  run this task in CI
//   !ci                 never run it (wins over ci)
//   ci:cpus:N           the machine size for it (boxd sizes: 1, 2, 4 or 8 vCPU)
//   ci:os:*             accepted and ignored (boxd machines are Ubuntu)
//   $TURBO_EXTENDS$     first entry of a package's task tags: keep the root's tags and add these
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

const EXTENDS = "$TURBO_EXTENDS$";
const SIZES = [1, 2, 4, 8];

type TaskDef = { tags?: unknown };
type TurboJson = { tags?: unknown; tasks?: Record<string, TaskDef | undefined> };

const asConfig = (v: unknown): TurboJson => (v && typeof v === "object" ? (v as TurboJson) : {});
const tagsOf = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : undefined;

export function resolveCiTasks(
  rootTurboJson: unknown,
  workspaces: Workspace[],
): { tasks: CiTask[]; warnings: string[] } {
  const root = asConfig(rootTurboJson);
  const rootTasks = root.tasks ?? {};
  // A repository whose only workspace is the root runs in Turborepo's single-package mode, where
  // tasks are plain names and `//#` selectors are refused.
  const singlePackage = workspaces.every((w) => w.name === "//");
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
      if (!tags.includes("ci") || tags.includes("!ci")) continue;

      const selector = singlePackage ? script : `${ws.name}#${script}`;
      const task: CiTask = { selector };
      const asked = tags.filter((t) => t.startsWith("ci:cpus:")).at(-1);
      if (asked) {
        const n = Number(asked.slice("ci:cpus:".length));
        if (Number.isFinite(n) && n > 0) {
          const size = SIZES.find((s) => s >= n);
          if (size === undefined)
            warnings.push(`${selector} asks for ${n} CPUs; boxd's largest machine has 8, so it runs on 8`);
          task.cpus = size ?? 8;
        } else {
          warnings.push(`${selector} has an unreadable tag ${asked}; it runs on the default size`);
        }
      }
      tasks.push(task);
    }
  }

  tasks.sort((a, b) => (a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0));
  warnings.sort();
  return { tasks, warnings };
}
