// What a repository's turbo.json files say CI runs, for init and doctor to tell you: the tasks tagged
// ci, or else the usual checks it defines (see USUAL_CHECKS in tags.ts).

import { parse } from "jsonc-parser";
import { USUAL_CHECKS } from "./tags.js";

type TurboJson = { tasks?: Record<string, { tags?: string[] } | undefined> };

const tasksOf = (text: string) => Object.entries((parse(text) as TurboJson | undefined)?.tasks ?? {});

/** The task names tagged ci (or ci:…) in any of these turbo.json files; `!ci` does not count. */
export function ciTaggedTasks(texts: string[]): string[] {
  const names = new Set<string>();
  for (const text of texts) {
    for (const [name, t] of tasksOf(text)) {
      if (t?.tags?.some((tag) => tag === "ci" || tag.startsWith("ci:"))) names.add(name);
    }
  }
  return [...names].sort();
}

/** The usual check tasks these turbo.json files define, plain (`lint`) or for one package (`web#lint`). */
export function usualChecks(texts: string[]): string[] {
  const defined = new Set(texts.flatMap((t) => tasksOf(t).map(([name]) => name.slice(name.indexOf("#") + 1))));
  return USUAL_CHECKS.filter((c) => defined.has(c));
}
