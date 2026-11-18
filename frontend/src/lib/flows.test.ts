import { describe, expect, it } from "vitest";

import { bucketRange, hourlyBuckets } from "./flows";

const now = Date.parse("2026-11-18T10:30:00Z");

describe("hourlyBuckets", () => {
  it("returns one bucket per hour ending at the current hour with gaps for empty hours", () => {
    const buckets = hourlyBuckets(
      [
        { at: "2026-11-18T10:00:00Z", count: 5 },
        { at: "2026-11-18T08:00:00Z", count: 2 },
        { at: "2026-11-17T09:00:00Z", count: 99 },
      ],
      24,
      now,
    );
    expect(buckets).toHaveLength(24);
    expect(buckets.at(-1)).toEqual({ at: Date.parse("2026-11-18T10:00:00Z"), count: 5 });
    expect(buckets.at(-2)?.count).toBeNull();
    expect(buckets.at(-3)?.count).toBe(2);
    expect(buckets[0]?.at).toBe(Date.parse("2026-11-17T11:00:00Z"));
    expect(buckets.some((b) => b.count === 99)).toBe(false);
  });

  it("covers a week as 168 hours", () => {
    expect(hourlyBuckets([], 7 * 24, now)).toHaveLength(168);
  });
});

describe("bucketRange", () => {
  it("treats empty buckets as zero", () => {
    expect(bucketRange(hourlyBuckets([{ at: "2026-11-18T10:00:00Z", count: 7 }], 24, now))).toEqual(
      { min: 0, max: 7 },
    );
    expect(bucketRange([])).toEqual({ min: 0, max: 0 });
  });
});
