// For a turbo.json without ci tags: tag the usual checks (lint, type checks, tests) that exist, the
// way Vercel CI asks for, keeping the file's comments and formatting.

import { applyEdits, modify, parse } from "jsonc-parser";

const CHECKS = ["lint", "type-check", "typecheck", "check-types", "types", "test", "test:unit"];

type TurboJson = { tasks?: Record<string, { tags?: string[] } | undefined> };

export function proposeCiTags(text: string): { text: string; tagged: string[] } {
  const tasks = (parse(text) as TurboJson | undefined)?.tasks ?? {};
  if (ciTaggedTasks([text]).length) return { text, tagged: [] };
  let out = text;
  const tagged: string[] = [];
  for (const name of Object.keys(tasks)) {
    if (!CHECKS.includes(name)) continue;
    const edits = modify(out, ["tasks", name, "tags"], [...(tasks[name]?.tags ?? []), "ci"], {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    });
    out = applyEdits(out, edits);
    tagged.push(name);
  }
  return { text: out, tagged };
}

/** The task names tagged ci (or ci:…) in any of these turbo.json files; `!ci` does not count. */
export function ciTaggedTasks(texts: string[]): string[] {
  const names = new Set<string>();
  for (const text of texts) {
    const tasks = (parse(text) as TurboJson | undefined)?.tasks ?? {};
    for (const [name, t] of Object.entries(tasks)) {
      if (t?.tags?.some((tag) => tag === "ci" || tag.startsWith("ci:"))) names.add(name);
    }
  }
  return [...names].sort();
}
