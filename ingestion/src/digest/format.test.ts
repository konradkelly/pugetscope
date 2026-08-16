import { describe, expect, it } from "vitest";
import {
  buildExtraFacts,
  buildPrompt,
  formatHourRange,
  formatNotableAircraft,
  formatWeekComparison,
  previousDay,
  type DigestStats,
  type NotableAircraft,
} from "./format.js";

// Everything the digest can say is derived from a DigestStats, so the fixture
// defaults to the "nothing optional is available" shape — each test opts back
// in to the one field it's about.
function stats(overrides: Partial<DigestStats> = {}): DigestStats {
  return {
    date: "2026-08-14",
    totalFlights: 100,
    byAirport: { KSEA: 60, KPAE: 20, KBFI: 12, KRNT: 5, KTIW: 3 },
    vsLastWeek: null,
    busiestHour: null,
    notableAircraft: [],
    ...overrides,
  };
}

function aircraft(overrides: Partial<NotableAircraft> = {}): NotableAircraft {
  return {
    icao24: "a1b2c3",
    registration: "N850GT",
    manufacturer: "Boeing",
    model: "747-8F",
    typecode: "B748",
    operator: "Atlas Air",
    ...overrides,
  };
}

describe("previousDay", () => {
  it("steps back one calendar day within a month", () => {
    expect(previousDay("2026-08-14")).toBe("2026-08-13");
  });

  it("rolls back across a month boundary into a 28-day February", () => {
    expect(previousDay("2026-03-01")).toBe("2026-02-28");
  });

  it("rolls back into February 29 in a leap year", () => {
    expect(previousDay("2028-03-01")).toBe("2028-02-29");
  });

  it("rolls back across a year boundary", () => {
    expect(previousDay("2026-01-01")).toBe("2025-12-31");
  });

  it("returns a full calendar day across the LA spring-forward date (a 23-hour local day)", () => {
    // 2026-03-08 is when LA loses an hour. The input is already an LA-local
    // calendar date and the arithmetic goes through Date.UTC, so the 23-hour
    // day is irrelevant — the digest must not skip or repeat a date here.
    expect(previousDay("2026-03-09")).toBe("2026-03-08");
    expect(previousDay("2026-03-08")).toBe("2026-03-07");
  });
});

describe("formatHourRange", () => {
  it("formats an afternoon hour in 12-hour time", () => {
    expect(formatHourRange(15)).toBe("3PM-4PM");
  });

  it("renders hour 0 as 12AM rather than 0AM", () => {
    expect(formatHourRange(0)).toBe("12AM-1AM");
  });

  it("crosses noon without calling it 0PM", () => {
    expect(formatHourRange(11)).toBe("11AM-12PM");
    expect(formatHourRange(12)).toBe("12PM-1PM");
  });

  it("wraps the end of the last hour of the day back to 12AM", () => {
    expect(formatHourRange(23)).toBe("11PM-12AM");
  });
});

describe("formatWeekComparison", () => {
  it("returns null when there's no rollup row from a week ago", () => {
    expect(formatWeekComparison(stats({ vsLastWeek: null }))).toBeNull();
  });

  it("describes an increase with a percentage", () => {
    expect(formatWeekComparison(stats({ totalFlights: 120, vsLastWeek: 100 }))).toBe(
      "Up 20 flights (20%) vs. the same day last week (100 flights).",
    );
  });

  it("describes a decrease with a percentage", () => {
    expect(formatWeekComparison(stats({ totalFlights: 80, vsLastWeek: 100 }))).toBe(
      "Down 20 flights (20%) vs. the same day last week (100 flights).",
    );
  });

  it("reports an exact match without a direction or percentage", () => {
    expect(formatWeekComparison(stats({ totalFlights: 100, vsLastWeek: 100 }))).toBe(
      "Same as this day last week (100 flights).",
    );
  });

  it("omits the percentage rather than dividing by zero when last week was 0 flights", () => {
    expect(formatWeekComparison(stats({ totalFlights: 5, vsLastWeek: 0 }))).toBe(
      "Up 5 flights vs. the same day last week (0 flights).",
    );
  });
});

describe("formatNotableAircraft", () => {
  it("returns null for an empty list so the caller can omit the line entirely", () => {
    expect(formatNotableAircraft([])).toBeNull();
  });

  it("describes an aircraft by manufacturer, model, registration and operator", () => {
    expect(formatNotableAircraft([aircraft()])).toBe("Boeing 747-8F (N850GT), operated by Atlas Air");
  });

  it("falls back to the typecode when manufacturer and model are both unknown", () => {
    expect(
      formatNotableAircraft([aircraft({ manufacturer: null, model: null, registration: null, operator: null })]),
    ).toBe("B748");
  });

  it("omits the optional registration and operator clauses when absent", () => {
    expect(formatNotableAircraft([aircraft({ registration: null, operator: null })])).toBe("Boeing 747-8F");
  });

  it("joins multiple aircraft with semicolons", () => {
    expect(
      formatNotableAircraft([
        aircraft({ registration: null, operator: null }),
        aircraft({ manufacturer: "Airbus", model: "A220-300", registration: null, operator: null }),
      ]),
    ).toBe("Boeing 747-8F; Airbus A220-300");
  });
});

// The grounding boundary. A fact that never reaches the prompt is a fact the
// model cannot be asked to describe, so these assert on *absence* — they're
// the mechanical half of the prompt's "never mention a comparison, busiest
// hour, or aircraft that isn't explicitly listed above" instruction.
describe("buildExtraFacts / buildPrompt grounding", () => {
  it("produces no extra facts at all when every optional statistic is missing", () => {
    expect(buildExtraFacts(stats())).toBe("");
  });

  it("keeps unavailable statistics out of the prompt entirely rather than sending them as zero or unknown", () => {
    const prompt = buildPrompt(stats());
    expect(prompt).not.toContain("last week");
    expect(prompt).not.toContain("Busiest hour");
    expect(prompt).not.toContain("First-ever tracked");
    // Nothing should leak in as a placeholder either.
    expect(prompt).not.toContain("null");
    expect(prompt).not.toContain("undefined");
  });

  it("includes each optional statistic once it is backed by real data", () => {
    const prompt = buildPrompt(
      stats({ totalFlights: 120, vsLastWeek: 100, busiestHour: 15, notableAircraft: [aircraft()] }),
    );
    expect(prompt).toContain("Up 20 flights (20%) vs. the same day last week (100 flights).");
    expect(prompt).toContain("Busiest hour: 3PM-4PM (most distinct aircraft observed).");
    expect(prompt).toContain("First-ever tracked today: Boeing 747-8F (N850GT), operated by Atlas Air");
  });

  it("includes a partial fact set without implying the missing ones", () => {
    const prompt = buildPrompt(stats({ busiestHour: 6 }));
    expect(prompt).toContain("Busiest hour: 6AM-7AM");
    expect(prompt).not.toContain("last week");
    expect(prompt).not.toContain("First-ever tracked");
  });

  it("always states the date, the region-wide total, and every airport's count", () => {
    const prompt = buildPrompt(stats());
    expect(prompt).toContain("2026-08-14");
    expect(prompt).toContain("Region-wide: 100 distinct aircraft");
    expect(prompt).toContain("KSEA: 60 flights");
    expect(prompt).toContain("KTIW: 3 flights");
  });

  it("reports a genuinely quiet airport as 0 rather than dropping it", () => {
    // Distinct from an *absent* statistic: a 0 here is a real observation from
    // a present rollup row, so the model should see it.
    const prompt = buildPrompt(stats({ byAirport: { KSEA: 60, KTIW: 0 } }));
    expect(prompt).toContain("KTIW: 0 flights");
  });
});
