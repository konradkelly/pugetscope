import { describe, expect, it } from "vitest";
import { utcRangeForLaDates } from "./trafficRollup.js";

describe("utcRangeForLaDates", () => {
  it("pads a single winter (PST) LA date by 1h on each side of its UTC-8 boundaries", () => {
    const { start, end } = utcRangeForLaDates(["2026-01-15"]);
    // LA midnight Jan 15 is 08:00 UTC; padded 1h earlier -> 07:00 UTC.
    expect(start.toISOString()).toBe("2026-01-15T07:00:00.000Z");
    // End uses the PDT (-07:00) offset per the source's own comment (the
    // "wider" offset on each side) -> next-day 00:00-07:00 is 07:00 UTC,
    // padded 1h later -> 08:00 UTC.
    expect(end.toISOString()).toBe("2026-01-16T08:00:00.000Z");
  });

  it("covers a summer (PDT) date too, despite assuming a UTC-8/-7 split", () => {
    const { start, end } = utcRangeForLaDates(["2026-07-15"]);
    const startMs = new Date("2026-07-15T00:00:00-07:00").getTime();
    const endMs = new Date("2026-07-16T00:00:00-07:00").getTime();
    // The padding is generous enough to be a superset of the real PDT day
    // regardless of which fixed offset the function assumes internally.
    expect(start.getTime()).toBeLessThanOrEqual(startMs);
    expect(end.getTime()).toBeGreaterThanOrEqual(endMs);
  });

  it("spans a multi-date (today+yesterday) contiguous range regardless of input order", () => {
    const forward = utcRangeForLaDates(["2026-03-09", "2026-03-10"]);
    const reversed = utcRangeForLaDates(["2026-03-10", "2026-03-09"]);
    expect(forward).toEqual(reversed);
    expect(forward.start.toISOString()).toBe("2026-03-09T07:00:00.000Z");
    expect(forward.end.toISOString()).toBe("2026-03-11T08:00:00.000Z");
  });
});
