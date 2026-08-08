import { describe, expect, it } from "vitest";
import { todayLA, yesterdayLA } from "./dateWindow.js";

describe("todayLA", () => {
  it("returns the LA calendar date for a UTC instant still 'today' in LA (PST, UTC-8)", () => {
    // 2026-01-15T06:00:00Z is 2026-01-14T22:00:00-08:00 — still Jan 14 in LA.
    expect(todayLA(new Date("2026-01-15T06:00:00Z"))).toBe("2026-01-14");
  });

  it("rolls over to the next LA calendar date once UTC crosses the PST offset", () => {
    // 2026-01-15T08:00:00Z is 2026-01-15T00:00:00-08:00 — now Jan 15 in LA.
    expect(todayLA(new Date("2026-01-15T08:00:00Z"))).toBe("2026-01-15");
  });

  it("uses the PDT (UTC-7) offset during daylight saving", () => {
    // 2026-07-15T06:30:00Z is 2026-07-14T23:30:00-07:00 — still Jul 14 in LA.
    expect(todayLA(new Date("2026-07-15T06:30:00Z"))).toBe("2026-07-14");
  });
});

describe("yesterdayLA", () => {
  it("is exactly one calendar day before todayLA", () => {
    const now = new Date("2026-03-10T20:00:00Z");
    expect(yesterdayLA(now)).toBe("2026-03-09");
    expect(todayLA(now)).toBe("2026-03-10");
  });

  it("crosses a month boundary correctly", () => {
    expect(yesterdayLA(new Date("2026-03-01T10:00:00Z"))).toBe("2026-02-28");
  });

  it("crosses a year boundary correctly", () => {
    // 2026-01-01T20:00:00Z is 2026-01-01T12:00:00-08:00 — today is Jan 1 in LA.
    expect(yesterdayLA(new Date("2026-01-01T20:00:00Z"))).toBe("2025-12-31");
  });
});
