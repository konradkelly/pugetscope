import { describe, expect, it } from "vitest";
import { utcRangeForLaDates } from "./overflightRollup.js";

// Same utcRangeForLaDates logic as trafficRollup.ts's copy (this repo's
// no-shared-package convention — see that file's own comment) — mirrored
// test coverage here rather than assuming the duplicate stays in sync.
describe("utcRangeForLaDates", () => {
  it("pads a single winter (PST) LA date by 1h on each side of its UTC-8 boundaries", () => {
    const { start, end } = utcRangeForLaDates(["2026-01-15"]);
    expect(start.toISOString()).toBe("2026-01-15T07:00:00.000Z");
    expect(end.toISOString()).toBe("2026-01-16T08:00:00.000Z");
  });

  it("spans a multi-date (today+yesterday) contiguous range regardless of input order", () => {
    const forward = utcRangeForLaDates(["2026-03-09", "2026-03-10"]);
    const reversed = utcRangeForLaDates(["2026-03-10", "2026-03-09"]);
    expect(forward).toEqual(reversed);
    expect(forward.start.toISOString()).toBe("2026-03-09T07:00:00.000Z");
    expect(forward.end.toISOString()).toBe("2026-03-11T08:00:00.000Z");
  });
});
