import { describe, expect, test } from "vitest";
import type { RunRecord } from "../src/core/record.js";
import { checkSummary, formatSeconds, GITHUB_LIMIT, terminalSummary } from "../src/core/report.js";
import type { TaskResult } from "../src/core/scheduler.js";

const run = (results: TaskResult[], status: RunRecord["status"] = "success"): RunRecord => ({
  id: "r1",
  repo: "acme/web",
  sha: "0123456789abcdef",
  ref: "main",
  trigger: "push",
  startedAt: "2026-10-30T10:00:00.000Z",
  finishedAt: "2026-10-30T10:00:25.400Z",
  status,
  results,
  machines: 2,
  snapshot: "boxd-turbo-web",
  warnings: [],
});
const r = (id: string, status: TaskResult["status"], seconds = 3, logTail = ""): TaskResult => ({
  id,
  status,
  seconds,
  logTail,
  machine: "bt-r1-1",
});

describe("formatSeconds", () => {
  test("under 90 seconds stays in seconds, above shows minutes, rounded half up", () => {
    expect(formatSeconds(7.2)).toBe("7s");
    expect(formatSeconds(65)).toBe("65s");
    expect(formatSeconds(89.4)).toBe("89s");
    expect(formatSeconds(89.5)).toBe("1m 30s");
    expect(formatSeconds(128)).toBe("2m 08s");
    expect(formatSeconds(774)).toBe("12m 54s");
  });
});

describe("checkSummary", () => {
  test("a failed run says how to get onto the machines kept for the failed tasks", () => {
    const out = checkSummary(run([r("a#test", "failed", 3, "boom"), r("b#test", "ran")], "failure"));
    expect(out.summary).toContain(
      "The machine of a failed task is kept for 24 hours, as the task left it: `boxd connect bt-r1-1`",
    );
    expect(checkSummary(run([r("b#test", "ran")])).summary).not.toContain("kept for 24 hours");
  });

  test("only the machines the run kept are offered, when it kept fewer than failed", () => {
    const failed = ["1", "2", "3", "4", "5"].map((n) => ({ ...r(`p${n}#test`, "failed"), machine: `bt-r1-${n}` }));
    const out = checkSummary({ ...run(failed, "failure"), kept: ["bt-r1-1", "bt-r1-2", "bt-r1-3"] });
    expect(out.summary).toContain("`boxd connect bt-r1-3`");
    expect(out.summary).not.toContain("`boxd connect bt-r1-4`");
  });

  test("a skipped task is marked with a circle", () => {
    const out = checkSummary(run([r("a#test", "failed"), r("b#test", "skipped")], "failure"));
    expect(out.summary).toContain("| ○ | `b#test` |");
  });

  test("a green run's title gives the time and what ran and what was restored", () => {
    const s = checkSummary(run([r("a#build", "restored", 0), r("a#test", "ran", 12), r("b#test", "ran", 4)]));
    expect(s.title).toBe("green in 25s: 2 ran, 1 restored");
  });

  test("a failed run's title names the failed tasks", () => {
    const s = checkSummary(run([r("a#test", "failed"), r("b#test", "failed"), r("c#test", "skipped")], "failure"));
    expect(s.title).toBe("failed: a#test, b#test (1 skipped)");
  });

  test("the table lists failed tasks first, then ran by time, then skipped", () => {
    const s = checkSummary(
      run(
        [r("fast#test", "ran", 2), r("slow#test", "ran", 40), r("bad#test", "failed", 5), r("x#test", "skipped", 0)],
        "failure",
      ),
    );
    const rows = s.summary.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| |"));
    expect(rows.map((l) => l.split("|")[2]?.trim())).toEqual(["`bad#test`", "`slow#test`", "`fast#test`", "`x#test`"]);
  });

  test("restored tasks are one line, not a row each", () => {
    const many = Array.from({ length: 249 }, (_, i) => r(`p${i}#test`, "restored", 0));
    const s = checkSummary(run([...many, r("a#test", "ran", 9)]));
    expect(s.summary).toContain("249 tasks restored from the cache");
    expect(s.summary.split("\n").filter((l) => l.includes("p17#test"))).toHaveLength(1);
  });

  test("failed logs keep their end and the whole output stays under GitHub's limit", () => {
    const huge = `${"noise\n".repeat(30_000)}THE REAL ERROR`;
    const s = checkSummary(run([r("a#test", "failed", 5, huge), r("b#test", "failed", 5, huge)], "failure"));
    expect(s.summary.length).toBeLessThanOrEqual(GITHUB_LIMIT);
    expect(s.text?.length).toBeLessThanOrEqual(GITHUB_LIMIT);
    expect(s.text?.match(/THE REAL ERROR/g)).toHaveLength(2);
  });

  test("logs full of multibyte glyphs stay under GitHub's limit in bytes, keeping each log's end", () => {
    const glyphs = " ✓ src/thing.test.ts (12 tests) ❯ × ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ failed\n".repeat(2000);
    const tasks = ["a", "b", "c", "d", "e"].map((p) => r(`${p}#test`, "failed", 5, `${glyphs}END OF ${p}`));
    const s = checkSummary(run(tasks, "failure"));
    expect(Buffer.byteLength(s.text ?? "")).toBeLessThanOrEqual(GITHUB_LIMIT);
    expect(Buffer.byteLength(s.summary)).toBeLessThanOrEqual(GITHUB_LIMIT);
    for (const p of ["a", "b", "c", "d", "e"]) expect(s.text).toContain(`END OF ${p}`);
    expect(s.text).not.toContain("\uFFFD");
  });

  test("a run that never got to its tasks explains why", () => {
    const s = checkSummary({ ...run([], "failure"), error: "the planner failed: no turbo.json" });
    expect(s.title).toBe("failed: the planner failed: no turbo.json");
  });
});

describe("terminalSummary", () => {
  test("one line per task that ran, failed or was skipped, then the totals", () => {
    const out = terminalSummary(
      run([r("a#build", "restored", 0), r("a#test", "ran", 12), r("b#test", "failed", 4)], "failure"),
    );
    expect(out).toContain("✗ b#test");
    expect(out).toContain("✓ a#test");
    expect(out).not.toContain("a#build");
    expect(out.trim().split("\n").at(-1)).toBe("failed in 25s · 1 ran · 1 restored · 1 failed · 2 machines");
  });
});
