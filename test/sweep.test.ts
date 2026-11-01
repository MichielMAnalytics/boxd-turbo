import { describe, expect, test } from "vitest";
import { leftovers } from "../src/core/sweep.js";

const now = Date.parse("2026-10-30T20:00:00Z");
const ago = (h: number) => new Date(now - h * 3600_000);
const worker = (name: string, status: string, run: string, age = 0.5) => ({
  id: name,
  name,
  status,
  createdAt: ago(age),
  labels: { "boxd-turbo": "worker", "boxd-turbo/run": run, "boxd-turbo/repo": "acme-web" },
});

describe("leftovers", () => {
  const runs: Record<string, string> = { r1: "success", r2: "running", r3: "failure" };
  const status = (_repo: string, run: string) => runs[run];

  test("a running machine of a finished run is left over; a live run's machines are not", () => {
    const found = leftovers(
      [worker("a", "running", "r1"), worker("b", "running", "r2"), worker("c", "running", "r3")],
      status,
      now,
    );
    expect(found.map((m) => m.name)).toEqual(["a", "c"]);
  });

  test("kept machines of failed tasks are never left over, whatever the SDK calls their state", () => {
    const kept = ["suspended", "standby", "hibernated", "hibernating", "stopped"].map((s, i) =>
      worker(`k${i}`, s, "r3"),
    );
    expect(leftovers(kept, status, now)).toEqual([]);
  });

  test("a kept machine someone woke by connecting is never left over: its timer runs for a day", () => {
    const woken = { ...worker("w", "running", "r3", 5), deleteAt: new Date(now + 20 * 3600_000) };
    expect(leftovers([woken], status, now)).toEqual([]);
  });

  test("a running machine older than three hours is left over even without a record, and old builders too", () => {
    const found = leftovers(
      [
        worker("old", "running", "gone", 4),
        worker("young", "running", "gone", 1),
        { id: "b1", name: "b1", status: "running", createdAt: ago(5), labels: { "boxd-turbo": "builder" } },
        { id: "b2", name: "b2", status: "running", createdAt: ago(1), labels: { "boxd-turbo": "builder" } },
      ],
      status,
      now,
    );
    expect(found.map((m) => m.name)).toEqual(["old", "b1"]);
  });
});
