// How a run reads: as a GitHub check (title, a table of tasks, the end of each failed log) and in
// the terminal.

import { type RunRecord, runSeconds } from "./record.js";
import type { TaskResult } from "./scheduler.js";

/** GitHub refuses a check run's summary or text longer than this. */
export const GITHUB_LIMIT = 65_535;

/** 7 → "7s", 128 → "2m 08s": seconds below 90, rounded half up, as the docs print times. */
export function formatSeconds(s: number): string {
  const t = Math.floor(s + 0.5);
  return t >= 90 ? `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s` : `${t}s`;
}

const count = (results: TaskResult[], status: TaskResult["status"]) =>
  results.filter((r) => r.status === status).length;
const ORDER: Record<TaskResult["status"], number> = { failed: 0, ran: 1, skipped: 2, restored: 3 };
const ordered = (results: TaskResult[]) =>
  [...results].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.seconds - a.seconds || (a.id < b.id ? -1 : 1));
const MARK: Record<TaskResult["status"], string> = { failed: "✗", ran: "✓", skipped: "–", restored: "↺" };

function title(r: RunRecord): string {
  const failed = r.results.filter((t) => t.status === "failed").map((t) => t.id);
  if (r.status === "running") return "running";
  if (r.status === "failure") {
    if (failed.length === 0) return `failed: ${r.error ?? "unknown error"}`;
    const shown =
      failed.length > 3 ? `${failed.slice(0, 3).join(", ")} and ${failed.length - 3} more` : failed.join(", ");
    const skipped = count(r.results, "skipped");
    return `failed: ${shown}${skipped ? ` (${skipped} skipped)` : ""}`;
  }
  return `green in ${formatSeconds(runSeconds(r))}: ${count(r.results, "ran")} ran, ${count(r.results, "restored")} restored`;
}

/** Keeps the end of `s` within `max` characters, marking the cut. */
function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = "… (earlier output cut)\n";
  return cut + s.slice(s.length - Math.max(0, max - cut.length));
}

export function checkSummary(r: RunRecord): { title: string; summary: string; text?: string } {
  const rows = ordered(r.results.filter((t) => t.status !== "restored"));
  const restored = r.results.filter((t) => t.status === "restored");
  const lines = [
    `${r.results.length} tasks on ${r.machines} machine${r.machines === 1 ? "" : "s"}, restored from \`${r.snapshot}\`.`,
    "",
  ];
  if (rows.length) {
    lines.push("| | task | time | machine |", "|---|---|---|---|");
    for (const t of rows)
      lines.push(`| ${MARK[t.status]} | \`${t.id}\` | ${formatSeconds(t.seconds)} | ${t.machine ?? ""} |`);
    lines.push("");
  }
  const kept = [
    ...new Set(r.results.filter((t) => t.status === "failed" && t.machine).map((t) => t.machine as string)),
  ];
  const connect = (m: string) => `\`boxd machine resume ${m} && boxd connect ${m}\``;
  if (kept.length === 1)
    lines.push(`The machine of a failed task is kept for 24 hours: ${connect(kept[0] as string)}`, "");
  else if (kept.length) {
    lines.push(
      "The machines of the failed tasks are kept for 24 hours:",
      "",
      ...kept.map((m) => `- ${connect(m)}`),
      "",
    );
  }
  if (restored.length) {
    lines.push(
      `<details><summary>${restored.length} tasks restored from the cache</summary>`,
      "",
      restored.map((t) => `\`${t.id}\``).join(" · "),
      "",
      "</details>",
    );
  }
  for (const w of r.warnings) lines.push(`> ${w}`);
  const summary = tail(lines.join("\n"), GITHUB_LIMIT);

  const failed = ordered(r.results.filter((t) => t.status === "failed" && t.logTail));
  if (failed.length === 0) return { title: title(r), summary };
  // Every failed task gets an equal share of the limit, and keeps the end of its log.
  const share = Math.floor(GITHUB_LIMIT / failed.length) - 100;
  const text = failed.map((t) => `### ${t.id}\n\`\`\`\n${tail(t.logTail, share)}\n\`\`\``).join("\n\n");
  return { title: title(r), summary, text: tail(text, GITHUB_LIMIT) };
}

export function terminalSummary(r: RunRecord): string {
  const width = Math.max(0, ...r.results.map((t) => t.id.length));
  const lines = ordered(r.results.filter((t) => t.status !== "restored")).map(
    (t) =>
      `${MARK[t.status]} ${t.id.padEnd(width)}  ${formatSeconds(t.seconds).padStart(7)}${t.status === "skipped" ? `  ${t.logTail}` : ""}`,
  );
  const verdict = r.status === "success" ? "green" : r.status === "failure" ? "failed" : "running";
  const parts = [
    `${verdict} in ${formatSeconds(runSeconds(r))}`,
    `${count(r.results, "ran")} ran`,
    `${count(r.results, "restored")} restored`,
  ];
  const failedCount = count(r.results, "failed");
  if (failedCount || r.status === "failure") parts.push(`${failedCount} failed`);
  parts.push(`${r.machines} machine${r.machines === 1 ? "" : "s"}`);
  return [...lines, "", parts.join(" · ")].join("\n");
}
