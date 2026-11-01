import { describe, expect, test } from "vitest";
import { newRunId } from "../src/core/record.js";

describe("newRunId", () => {
  test("sorts by time and ends with the short sha", () => {
    expect(newRunId("0123456789abcdef", new Date("2026-10-30T10:15:03.120Z"))).toBe("20261030-101503-0123456");
  });
});
