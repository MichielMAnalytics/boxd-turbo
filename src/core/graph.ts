// The work for one run, from Turborepo's dry run: the selected CI tasks plus everything they depend
// on, each marked cached (its result is in the cache) or not.

import type { CiTask } from "./tags.js";

/** The part of `turbo run --dry=json` this reads. */
export type TurboDryRun = {
  tasks: {
    taskId: string;
    task: string;
    package: string;
    directory: string;
    hash: string;
    cache: { status: string };
    dependencies: string[] | null;
    outputs: string[] | null;
    command: string;
    /** Where Turborepo writes the task's output, relative to the repository root. */
    logFile?: string;
  }[];
};

export type TaskNode = {
  id: string;
  pkg: string;
  task: string;
  /** The package directory, relative to the repository root ("" for the root). */
  dir: string;
  hash: string;
  deps: string[];
  outputs: string[];
  /** Turborepo has this task's result: restoring it is all a run needs. */
  cached: boolean;
  /** The package has no script for this task: nothing to run. */
  noop: boolean;
  cpus?: number;
  /** Where Turborepo writes the task's output, relative to the repository root. */
  logFile?: string;
};

export type TaskGraph = { nodes: Map<string, TaskNode>; selected: Set<string> };

const NO_SCRIPT = "<NONEXISTENT>";

export function buildGraph(dry: TurboDryRun, selectors: CiTask[]): TaskGraph {
  const byId = new Map(dry.tasks.map((t) => [t.taskId, t]));
  const resolve = (s: string) => (byId.has(s) ? s : byId.has(`//#${s}`) ? `//#${s}` : undefined);
  const missing = selectors.filter((s) => resolve(s.selector) === undefined).map((s) => s.selector);
  if (missing.length) throw new Error(`Turborepo has no task ${missing.join(", ")}`);

  const cpus = new Map(selectors.map((s) => [resolve(s.selector) as string, s.cpus]));
  const selected = new Set(selectors.map((s) => resolve(s.selector) as string));
  const nodes = new Map<string, TaskNode>();
  const stack = [...selected];
  while (stack.length) {
    const id = stack.pop() as string;
    if (nodes.has(id)) continue;
    const t = byId.get(id);
    if (!t) throw new Error(`Turborepo lists ${id} as a dependency but has no such task`);
    const node: TaskNode = {
      id,
      pkg: t.package,
      task: t.task,
      dir: t.directory,
      hash: t.hash,
      deps: t.dependencies ?? [],
      outputs: t.outputs ?? [],
      cached: t.cache.status === "HIT",
      noop: t.command === NO_SCRIPT,
    };
    const c = cpus.get(id);
    if (c !== undefined) node.cpus = c;
    if (t.logFile) node.logFile = t.logFile;
    nodes.set(id, node);
    stack.push(...node.deps);
  }
  const graph = { nodes, selected };
  topoOrder(graph); // throws on a cycle
  return graph;
}

/** Every node, each after all of its dependencies. Throws on a dependency cycle. */
export function topoOrder(g: TaskGraph): TaskNode[] {
  const order: TaskNode[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]) => {
    const s = state.get(id);
    if (s === "done") return;
    if (s === "visiting") {
      const cycle = [...path.slice(path.indexOf(id)), id];
      throw new Error(`dependency cycle: ${cycle.join(" -> ")}`);
    }
    state.set(id, "visiting");
    const node = g.nodes.get(id) as TaskNode;
    for (const d of node.deps) visit(d, [...path, id]);
    state.set(id, "done");
    order.push(node);
  };
  for (const id of [...g.nodes.keys()].sort()) visit(id, []);
  return order;
}

/** The tasks a run has to execute, in dependency order: not cached, and with a script. */
export function toRun(g: TaskGraph): TaskNode[] {
  return topoOrder(g).filter((n) => !n.cached && !n.noop);
}

/**
 * How urgent each task is: its own duration plus the longest chain of work waiting on it.
 * Starting the highest first shortens the run. Unknown durations count as one second.
 */
export function priorities(g: TaskGraph, durations: Record<string, number>): Map<string, number> {
  const dependents = new Map<string, string[]>();
  for (const n of g.nodes.values()) for (const d of n.deps) dependents.set(d, [...(dependents.get(d) ?? []), n.id]);
  const memo = new Map<string, number>();
  const score = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const below = Math.max(0, ...(dependents.get(id) ?? []).map(score));
    const s = (durations[id] ?? 1) + below;
    memo.set(id, s);
    return s;
  };
  for (const id of g.nodes.keys()) score(id);
  return memo;
}

/**
 * The declared outputs of these tasks and of everything they depend on, one entry per package
 * directory. A machine deletes them before a group runs, so every file in them comes from this run's
 * build or from the cache, never from the snapshot.
 */
export function closureOutputs(g: TaskGraph, tasks: TaskNode[]): { dir: string; globs: string[] }[] {
  const byDir = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const stack = tasks.map((t) => t.id);
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = g.nodes.get(id);
    if (!n) continue;
    if (n.outputs.length) {
      const globs = byDir.get(n.dir) ?? new Set<string>();
      for (const o of n.outputs) globs.add(o);
      byDir.set(n.dir, globs);
    }
    stack.push(...n.deps);
  }
  return [...byDir.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dir, globs]) => ({ dir, globs: [...globs] }));
}
