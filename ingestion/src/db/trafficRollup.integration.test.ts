import { describe, expect, it } from "vitest";
import { refreshTrafficRollup } from "./trafficRollup.js";
import { insertPositions, pool } from "./postgres.js";
import type { StateVector } from "../openskyClient.js";
import { REGIONAL_AIRPORTS } from "../enrichment/regionalAirports.js";

const KSEA = REGIONAL_AIRPORTS.find((a) => a.icao === "KSEA")!;
const KPAE = REGIONAL_AIRPORTS.find((a) => a.icao === "KPAE")!;
const KBFI = REGIONAL_AIRPORTS.find((a) => a.icao === "KBFI")!;

// 2026-03-10 is in PDT (DST starts 2026-03-08), so LA-local hours map to
// UTC-7 here — see dateWindow.test.ts for the equivalent PST-side math.
function laHourToUnixSeconds(dateIso: string, hourLa: number): number {
  return Math.floor(new Date(`${dateIso}T${String(hourLa + 7).padStart(2, "0")}:00:00Z`).getTime() / 1000);
}

// Defaults describe an aircraft on approach: low, and descending. Both
// matter — trafficRollup attributes a position to a field only if it passes
// the same distance-aware altitude gate and climb/descent check that
// inferFlightPhase applies (see regionalAirports.ts). A level aircraft at
// cruise inside the radius is a transit, not an operation, and is excluded.
function state(
  icao24: string,
  lat: number,
  lon: number,
  unixSeconds: number,
  { altitude = 150, verticalRate = -3 }: { altitude?: number; verticalRate?: number } = {},
): StateVector {
  return {
    icao24, callsign: `T${icao24.slice(-4).toUpperCase()}`, originCountry: "United States",
    timePosition: unixSeconds, lastContact: unixSeconds, longitude: lon, latitude: lat,
    baroAltitude: altitude, onGround: false, velocity: 120, trueTrack: 180,
    verticalRate, geoAltitude: altitude, squawk: null, spi: false, category: null,
  };
}

describe("refreshTrafficRollup", () => {
  it("aggregates distinct-aircraft daily/hourly counts per airport scope and REGION", async () => {
    const date = "2026-03-10";
    const hour10 = laHourToUnixSeconds(date, 10);
    const hour14 = laHourToUnixSeconds(date, 14);

    await insertPositions([
      // Two distinct aircraft at KSEA, hour 10 — counts once each toward
      // KSEA's daily total and hour-10 bucket (COUNT(DISTINCT icao24)).
      state("ksea0001", KSEA.lat, KSEA.lon, hour10),
      state("ksea0002", KSEA.lat, KSEA.lon, hour10),
      // Same first aircraft seen again at KSEA, hour 14 — same day, later
      // hour: contributes to hour-14's bucket but must NOT double-count the
      // daily total (still 2 distinct aircraft for the whole day).
      state("ksea0001", KSEA.lat, KSEA.lon, hour14),
      // An aircraft near KPAE only — outside KSEA's approach radius
      // (~51km away, see regionalAirports.test.ts), so it must not count
      // toward KSEA's scope, but must count toward REGION and KPAE's own.
      state("kpae0001", KPAE.lat, KPAE.lon, hour10),
    ]);

    await refreshTrafficRollup(pool, [date]);

    const ksea = await pool.query(
      "SELECT flights FROM traffic_daily_counts WHERE scope = 'KSEA' AND date = $1",
      [date],
    );
    expect(ksea.rows[0].flights).toBe(2);

    const region = await pool.query(
      "SELECT flights FROM traffic_daily_counts WHERE scope = 'REGION' AND date = $1",
      [date],
    );
    expect(region.rows[0].flights).toBe(3); // ksea0001, ksea0002, kpae0001

    const kpae = await pool.query(
      "SELECT flights FROM traffic_daily_counts WHERE scope = 'KPAE' AND date = $1",
      [date],
    );
    expect(kpae.rows[0].flights).toBe(1);

    // All 24 hours get a row now, explicitly zero where nothing qualified —
    // that's what lets a count legitimately drop back to zero instead of
    // leaving a stale higher number behind. Assert on the populated ones.
    const hourlyKsea = await pool.query(
      `SELECT hour, flights FROM traffic_hourly_counts
       WHERE scope = 'KSEA' AND date = $1 AND flights > 0 ORDER BY hour`,
      [date],
    );
    expect(hourlyKsea.rows).toEqual([
      { hour: 10, flights: 2 },
      { hour: 14, flights: 1 },
    ]);

    const hourCount = await pool.query(
      "SELECT COUNT(*)::int AS n FROM traffic_hourly_counts WHERE scope = 'KSEA' AND date = $1",
      [date],
    );
    expect(hourCount.rows[0].n).toBe(24);
  });

  it("upserts (ON CONFLICT DO UPDATE) rather than duplicating rows on a second refresh", async () => {
    const date = "2026-03-11";
    const hour = laHourToUnixSeconds(date, 9);
    await insertPositions([state("dup0001", KSEA.lat, KSEA.lon, hour)]);

    await refreshTrafficRollup(pool, [date]);
    await insertPositions([state("dup0002", KSEA.lat, KSEA.lon, hour)]);
    await refreshTrafficRollup(pool, [date]);

    const rows = await pool.query(
      "SELECT flights FROM traffic_daily_counts WHERE scope = 'KSEA' AND date = $1",
      [date],
    );
    expect(rows.rows).toHaveLength(1); // still one row for this (scope, date), not two
    expect(rows.rows[0].flights).toBe(2); // updated to reflect both aircraft
  });

  // Regression: KSEA/KBFI/KRNT sit 7.6-8.9km apart with 25/12/8km approach
  // radii, so each field's reference point falls inside its neighbours'
  // circles. The rollup used to attribute a position to every airport whose
  // radius contained it, so one Sea-Tac arrival was counted as traffic at
  // Boeing Field and Renton too — inflating the small fields far more than
  // SEA, because they have less real traffic for the leak to hide in.
  it("attributes an arrival to the nearest field only, not every overlapping radius", async () => {
    const date = "2026-03-12";
    const hour = laHourToUnixSeconds(date, 11);

    // Descending onto Sea-Tac, right over the runway. KBFI (8.9km) and KRNT
    // (8.5km) both contain this point within their own radii.
    await insertPositions([state("overlap1", KSEA.lat, KSEA.lon, hour)]);
    await refreshTrafficRollup(pool, [date]);

    const rows = await pool.query(
      `SELECT scope, flights FROM traffic_daily_counts
       WHERE date = $1 AND scope IN ('KSEA','KBFI','KRNT') ORDER BY scope`,
      [date],
    );
    expect(rows.rows).toEqual([
      { scope: "KBFI", flights: 0 },
      { scope: "KRNT", flights: 0 },
      { scope: "KSEA", flights: 1 },
    ]);
  });

  // The opposite failure mode: nearest-wins must not starve the small fields.
  // KBFI sits inside KSEA's 25km radius, so a genuine Boeing Field arrival is
  // within both — it belongs to KBFI because KBFI is closer, and must not be
  // swallowed by its much larger neighbour.
  it("keeps a genuine small-field arrival at that field, not its larger neighbour", async () => {
    const date = "2026-03-15";
    const hour = laHourToUnixSeconds(date, 13);

    await insertPositions([state("bfiarr01", KBFI.lat, KBFI.lon, hour)]);
    await refreshTrafficRollup(pool, [date]);

    const rows = await pool.query(
      `SELECT scope, flights FROM traffic_daily_counts
       WHERE date = $1 AND scope IN ('KSEA','KBFI') ORDER BY scope`,
      [date],
    );
    expect(rows.rows).toEqual([
      { scope: "KBFI", flights: 1 },
      { scope: "KSEA", flights: 0 },
    ]);
  });

  // The other half of the same bug: there was no altitude gate at all, so an
  // airliner crossing the region at cruise counted as an operation at
  // whichever fields it passed over.
  it("excludes a high transit over a field, and level flight through the corridor", async () => {
    const date = "2026-03-13";
    const hour = laHourToUnixSeconds(date, 12);

    await insertPositions([
      // Directly over Sea-Tac at 10,000m — the gate allows ~300m here.
      state("cruise01", KSEA.lat, KSEA.lon, hour, { altitude: 10000, verticalRate: 0 }),
      // Low enough, but neither climbing nor descending: a transit.
      state("level001", KSEA.lat, KSEA.lon, hour, { altitude: 150, verticalRate: 0 }),
      // A genuine arrival, so the assertion below can't pass vacuously.
      state("arrive01", KSEA.lat, KSEA.lon, hour),
    ]);
    await refreshTrafficRollup(pool, [date]);

    const ksea = await pool.query(
      "SELECT flights FROM traffic_daily_counts WHERE scope = 'KSEA' AND date = $1",
      [date],
    );
    expect(ksea.rows[0].flights).toBe(1);

    // REGION is deliberately ungated — "aircraft seen anywhere in the
    // coverage area" is a different question, and all three were seen.
    const region = await pool.query(
      "SELECT flights FROM traffic_daily_counts WHERE scope = 'REGION' AND date = $1",
      [date],
    );
    expect(region.rows[0].flights).toBe(3);
  });

  // A combination that drops to zero must be written as an explicit 0, not
  // left at whatever higher number a previous refresh wrote.
  it("overwrites a stale higher count with zero when nothing qualifies", async () => {
    const date = "2026-03-14";
    const hour = laHourToUnixSeconds(date, 8);

    await pool.query(
      `INSERT INTO traffic_daily_counts (scope, date, flights) VALUES ('KTIW', $1, 99)
       ON CONFLICT (scope, date) DO UPDATE SET flights = 99`,
      [date],
    );
    await insertPositions([state("tiwzero1", KSEA.lat, KSEA.lon, hour)]);
    await refreshTrafficRollup(pool, [date]);

    const rows = await pool.query(
      "SELECT flights FROM traffic_daily_counts WHERE scope = 'KTIW' AND date = $1",
      [date],
    );
    expect(rows.rows[0].flights).toBe(0);
  });

  it("is a no-op for an empty dates array", async () => {
    await expect(refreshTrafficRollup(pool, [])).resolves.toBeUndefined();
  });
});
