import { describe, expect, it } from "vitest";
import { refreshTrafficRollup } from "./trafficRollup.js";
import { insertPositions, pool } from "./postgres.js";
import type { StateVector } from "../openskyClient.js";
import { REGIONAL_AIRPORTS } from "../enrichment/regionalAirports.js";

const KSEA = REGIONAL_AIRPORTS.find((a) => a.icao === "KSEA")!;
const KPAE = REGIONAL_AIRPORTS.find((a) => a.icao === "KPAE")!;

// 2026-03-10 is in PDT (DST starts 2026-03-08), so LA-local hours map to
// UTC-7 here — see dateWindow.test.ts for the equivalent PST-side math.
function laHourToUnixSeconds(dateIso: string, hourLa: number): number {
  return Math.floor(new Date(`${dateIso}T${String(hourLa + 7).padStart(2, "0")}:00:00Z`).getTime() / 1000);
}

function state(icao24: string, lat: number, lon: number, unixSeconds: number): StateVector {
  return {
    icao24, callsign: `T${icao24.slice(-4).toUpperCase()}`, originCountry: "United States",
    timePosition: unixSeconds, lastContact: unixSeconds, longitude: lon, latitude: lat,
    baroAltitude: 3000, onGround: false, velocity: 120, trueTrack: 180,
    verticalRate: 0, geoAltitude: 3000, squawk: null, spi: false, category: null,
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

    const hourlyKsea = await pool.query(
      "SELECT hour, flights FROM traffic_hourly_counts WHERE scope = 'KSEA' AND date = $1 ORDER BY hour",
      [date],
    );
    expect(hourlyKsea.rows).toEqual([
      { hour: 10, flights: 2 },
      { hour: 14, flights: 1 },
    ]);
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

  it("is a no-op for an empty dates array", async () => {
    await expect(refreshTrafficRollup(pool, [])).resolves.toBeUndefined();
  });
});
