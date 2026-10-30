import { describe, expect, test } from "vitest";
import { learnDurations, newRunId, type RunRecord } from "../src/core/record.js";

const rec = (startedAt: string, results: RunRecord["results"]): RunRecord => ({
  id: startedAt,
  repo: "acme/web",
  sha: "abc",
  ref: "main",
  trigger: "push",
  startedAt,
  status: "success",
  results,
  machines: 1,
  snapshot: "s",
  warnings: [],
});

describe("learnDurations", () => {
  test("takes each task's time from the latest run that ran it", () => {
    const d = learnDurations([
      rec("2026-10-30T10:00:00Z", [{ id: "a#test", status: "ran", seconds: 30, logTail: "" }]),
      rec("2026-10-29T10:00:00Z", [
        { id: "a#test", status: "ran", seconds: 99, logTail: "" },
        { id: "b#test", status: "ran", seconds: 7, logTail: "" },
      ]),
    ]);
    expect(d).toEqual({ "a#test": 30, "b#test": 7 });
  });

  test("ignores restored, failed and skipped tasks", () => {
    const d = learnDurations([
      rec("2026-10-30T10:00:00Z", [
        { id: "a#test", status: "restored", seconds: 0, logTail: "" },
        { id: "b#test", status: "failed", seconds: 3, logTail: "" },
      ]),
    ]);
    expect(d).toEqual({});
  });
});

describe("newRunId", () => {
  test("sorts by time and ends with the short sha", () => {
    expect(newRunId("0123456789abcdef", new Date("2026-10-30T10:15:03.120Z"))).toBe("20261030-101503-0123456");
  });
});
