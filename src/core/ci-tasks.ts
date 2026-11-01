// What a repository's turbo.json files say CI runs, for init and doctor to tell you: the tasks tagged
// ci, or else the usual checks it defines (see USUAL_CHECKS in tags.ts).

import { parse } from "jsonc-parser";
import { USUAL_CHECKS } from "./tags.js";

type TurboJson = { extends?: unknown; tags?: unknown; tasks?: Record<string, { tags?: unknown } | undefined> };

const parsed = (text: string): TurboJson => {
  const v = parse(text) as unknown;
  return v && typeof v === "object" ? (v as TurboJson) : {};
};
const tasksOf = (text: string) => Object.entries(parsed(text).tasks ?? {});
const hasCi = (tags: unknown) => Array.isArray(tags) && tags.includes("ci");

const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
const extendsRoot = (text: string) => {
  const ext = parsed(text).extends;
  return Array.isArray(ext) && ext.includes("//");
};

/**
 * The texts of the turbo.json files Turborepo reads for this repository: the root's, and each
 * package's (one that extends "//"). A nested turbo.json that does not extend "//" is another
 * Turborepo, a test fixture say, and it and everything under it are left out.
 */
export function ownConfigs(files: { path: string; text: string }[]): string[] {
  const nested = files.filter((f) => f.path.includes("/"));
  const otherRoots = nested.filter((f) => !extendsRoot(f.text)).map((f) => dirOf(f.path));
  return files
    .filter(
      (f) => !f.path.includes("/") || (extendsRoot(f.text) && !otherRoots.some((dir) => dirOf(f.path).startsWith(dir))),
    )
    .map((f) => f.text);
}

/**
 * The task names tagged ci in any of these turbo.json files, the way the planner reads them: the tag
 * itself, not `ci:cpus:N` alone, and `!ci` does not count. A package tagged ci as a whole is named so.
 */
export function ciTaggedTasks(texts: string[]): string[] {
  const names = new Set<string>();
  for (const text of texts) {
    for (const [name, t] of tasksOf(text)) if (hasCi(t?.tags)) names.add(name);
    if (hasCi(parsed(text).tags)) names.add("every task of a package tagged ci");
  }
  return [...names].sort();
}

/** The usual check tasks these turbo.json files define, plain (`lint`) or for one package (`web#lint`). */
export function usualChecks(texts: string[]): string[] {
  const defined = new Set(texts.flatMap((t) => tasksOf(t).map(([name]) => name.slice(name.indexOf("#") + 1))));
  return USUAL_CHECKS.filter((c) => defined.has(c));
}
