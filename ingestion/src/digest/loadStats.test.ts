import type pg from "pg";
import { describe, expect, it } from "vitest";
import { REGIONAL_AIRPORTS } from "../enrichment/regionalAirports.js";
import { loadStats, NOTABLE_AIRCRAFT_LIMIT } from "./loadStats.js";
import type { NotableAircraft } from "./format.js";

interface FakeRows {
  daily?: Array<{ scope: string; flights: number | string }>;
  lastWeek?: Array<{ flights: number | string }>;
  hourly?: Array<{ hour: number | string }>;
  aircraft?: unknown[];
}

// Dispatches on the SQL text rather than call order, since loadStats fires the
// last three queries concurrently via Promise.all. The week-ago lookup has to
// be matched before the generic traffic_daily_counts case — both hit that
// table, and only the former carries the interval. Optionally records the raw
// SQL text alongside params (seenSql) — the mock is a plain fixture dispatcher,
// not a real query engine, so it can't validate a WHERE clause's actual
// filtering behavior; pinning the SQL text is the only way this suite can
// catch a regression to the query's shape (e.g. an accidentally-dropped
// filter) without standing up a real Postgres.
function fakePool(rows: FakeRows, seenParams: unknown[][] = [], seenSql: string[] = []) {
  return {
    query: async (sql: string, params: unknown[]) => {
      seenParams.push(params);
      seenSql.push(sql);
      if (sql.includes("interval '7 days'")) return { rows: rows.lastWeek ?? [] };
      if (sql.includes("traffic_hourly_counts")) return { rows: rows.hourly ?? [] };
      if (sql.includes("FROM aircraft")) return { rows: rows.aircraft ?? [] };
      if (sql.includes("traffic_daily_counts")) return { rows: rows.daily ?? [] };
      throw new Error(`unexpected query in test: ${sql}`);
    },
  } as unknown as pg.Pool;
}

function notableAircraft(overrides: Partial<NotableAircraft> = {}): NotableAircraft {
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

const REGION_100 = [{ scope: "REGION", flights: 100 }];

describe("loadStats", () => {
  it("throws rather than publishing a digest when the rollup hasn't produced a REGION row", async () => {
    await expect(loadStats(fakePool({ daily: [] }), "2026-08-14")).rejects.toThrow(
      /no REGION traffic_daily_counts row for 2026-08-14/,
    );
  });

  it("still throws when airport rows exist but the REGION row is missing", async () => {
    // The partial-rollup case: without this guard the region-wide total would
    // silently fall back to 0 and the digest would report a day that never
    // happened.
    const pool = fakePool({ daily: [{ scope: "KSEA", flights: 60 }] });
    await expect(loadStats(pool, "2026-08-14")).rejects.toThrow(/rollup likely hasn't run yet/);
  });

  it("accepts a REGION row of 0 flights as a genuinely quiet day, not a missing rollup", async () => {
    const result = await loadStats(fakePool({ daily: [{ scope: "REGION", flights: 0 }] }), "2026-08-14");
    expect(result.totalFlights).toBe(0);
  });

  it("coerces pg's string-typed counts to numbers", async () => {
    // COUNT(DISTINCT ...) comes back from pg as a bigint string; without the
    // Number() coercion the week-over-week delta would be string concatenation.
    const pool = fakePool({
      daily: [{ scope: "REGION", flights: "120" }],
      lastWeek: [{ flights: "100" }],
      hourly: [{ hour: "15" }],
    });
    const result = await loadStats(pool, "2026-08-14");
    expect(result.totalFlights).toBe(120);
    expect(result.vsLastWeek).toBe(100);
    expect(result.busiestHour).toBe(15);
  });

  it("reports every regional airport, defaulting the ones with no rollup row to 0", async () => {
    const pool = fakePool({ daily: [...REGION_100, { scope: "KSEA", flights: 60 }] });
    const result = await loadStats(pool, "2026-08-14");
    expect(Object.keys(result.byAirport)).toHaveLength(REGIONAL_AIRPORTS.length);
    expect(result.byAirport.KSEA).toBe(60);
    for (const airport of REGIONAL_AIRPORTS) {
      if (airport.icao !== "KSEA") expect(result.byAirport[airport.icao]).toBe(0);
    }
  });

  it("leaves the optional statistics null when their queries return nothing", async () => {
    const result = await loadStats(fakePool({ daily: REGION_100 }), "2026-08-14");
    expect(result.vsLastWeek).toBeNull();
    expect(result.busiestHour).toBeNull();
    expect(result.notableAircraft).toEqual([]);
  });

  it("passes the requested date to every query so the digest can't mix dates", async () => {
    const seenParams: unknown[][] = [];
    await loadStats(fakePool({ daily: REGION_100 }, seenParams), "2026-08-14");
    expect(seenParams).toHaveLength(4);
    for (const params of seenParams) expect(params).toEqual(["2026-08-14"]);
  });

  it("passes notable aircraft rows through unchanged", async () => {
    const rows = [notableAircraft(), notableAircraft({ icao24: "d4e5f6", typecode: "A320" })];
    const result = await loadStats(fakePool({ daily: REGION_100, aircraft: rows }), "2026-08-14");
    expect(result.notableAircraft).toEqual(rows);
  });

  // The mock above can't validate real Postgres filtering — it just returns
  // whatever fixture rows a test hands it, regardless of the WHERE clause.
  // So this pins the query *text* instead: it's the only way this suite can
  // catch a regression to the filter combination that made this feature
  // effectively never surface anything in production (see the comment above
  // loadNotableAircraft() and docs/SPEC.md §17.2). Losing either clause here
  // is a real, silent regression — dropping `typecode IS NOT NULL` reopens
  // the old "no typecode to describe" digest sentences, and dropping the
  // `first_seen`/timezone clause would match every historical sighting
  // instead of just the target date's.
  describe("notable-aircraft query shape", () => {
    async function aircraftQuerySql(): Promise<string> {
      const seenSql: string[] = [];
      await loadStats(fakePool({ daily: REGION_100 }, [], seenSql), "2026-08-14");
      const sql = seenSql.find((s) => s.includes("FROM aircraft"));
      if (!sql) throw new Error("no query against the aircraft table was issued");
      return sql;
    }

    it("only selects aircraft already enriched with a typecode", async () => {
      expect(await aircraftQuerySql()).toContain("typecode IS NOT NULL");
    });

    it("matches first_seen against the requested date in LA-local time, not UTC", async () => {
      const sql = await aircraftQuerySql();
      expect(sql).toContain("first_seen AT TIME ZONE 'America/Los_Angeles'");
      expect(sql).toContain("::date = $1::date");
    });

    it("caps the result at NOTABLE_AIRCRAFT_LIMIT", async () => {
      expect(await aircraftQuerySql()).toContain(`LIMIT ${NOTABLE_AIRCRAFT_LIMIT}`);
    });
  });
});
