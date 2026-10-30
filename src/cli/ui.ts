// Terminal output: color when it is a terminal, plain text otherwise, and the live lines of a run.

import { formatSeconds } from "../core/report.js";
import type { PipelineEvent } from "../pipeline.js";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const green = paint(32);
export const red = paint(31);
export const yellow = paint(33);
export const dim = paint(2);
export const bold = paint(1);

export type Out = { line(s?: string): void; json(v: unknown): void };
export const stdout: Out = {
  line: (s = "") => process.stdout.write(`${s}\n`),
  json: (v) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`),
};

/** "  12.3s  message", timed from the start of the command. */
export function clock(out: Out, t0 = Date.now()) {
  return (message: string) => out.line(`${dim(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`)}  ${message}`);
}

/** The live view of a run: phases, the plan, and every task as it starts and ends. */
export function runPrinter(say: (m: string) => void) {
  return (e: PipelineEvent) => {
    if (e.type === "phase") say(e.message);
    else if (e.type === "plan")
      say(`${e.tasks} tasks, ${bold(String(e.toRun))} to run, ${e.restored} restored from the cache`);
    else if (e.type === "start") say(dim(`▸ ${e.tasks.join(", ")} on ${e.worker}`));
    else if (e.type === "done") {
      const r = e.result;
      const mark = r.status === "failed" ? red("✗") : r.status === "restored" ? dim("↺") : green("✓");
      say(`${mark} ${r.id} ${dim(formatSeconds(r.seconds))}`);
    } else if (e.type === "skip") say(dim(`○ ${e.id} skipped, ${e.because}`));
  };
}

export const ago = (iso: string, now = Date.now()) => {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129_600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
};
