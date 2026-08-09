import { beforeEach, describe, expect, it } from "vitest";
import { refreshOverflightRollup, NOISE_ZIPS } from "./overflightRollup.js";
import { insertPositions, pool } from "./postgres.js";
import type { StateVector } from "../openskyClient.js";

// A ~7km x 11km box around (47.5, -122.3) — arbitrary, just needs to be a
// real polygon a test position can land inside/outside of. Tagged with a
// real curated NOISE_ZIPS entry, since refreshOverflightRollup's query
// filters to `zcta5 = ANY(NOISE_ZIPS)` regardless of geometry.
const TEST_ZIP = "98108";
const INSIDE = { lat: 47.5, lon: -122.3 };
const OUTSIDE = { lat: 48.5, lon: -121.0 };

async function seedZipBoundary(): Promise<void> {
  await pool.query(
    `INSERT INTO zip_boundaries (zcta5, boundary)
     VALUES ($1, ST_Multi(ST_GeomFromText(
       'POLYGON((-122.35 47.45, -122.25 47.45, -122.25 47.55, -122.35 47.55, -122.35 47.45))', 4326
     ))::geography)`,
    [TEST_ZIP],
  );
}

function laHourToUnixSeconds(dateIso: string, hourLa: number): number {
  // Same PDT (UTC-7) assumption as trafficRollup.integration.test.ts.
  return Math.floor(new Date(`${dateIso}T${String(hourLa + 7).padStart(2, "0")}:00:00Z`).getTime() / 1000);
}

function state(icao24: string, lat: number, lon: number, unixSeconds: number, geoAltitude: number): StateVector {
  return {
    icao24, callsign: `T${icao24.slice(-4).toUpperCase()}`, originCountry: "United States",
    timePosition: unixSeconds, lastContact: unixSeconds, longitude: lon, latitude: lat,
    baroAltitude: geoAltitude, onGround: false, velocity: 120, trueTrack: 180,
    verticalRate: 0, geoAltitude, squawk: null, spi: false, category: null,
  };
}

beforeEach(async () => {
  await seedZipBoundary();
});

describe("NOISE_ZIPS", () => {
  it("includes the curated zip this test seeds against", () => {
    expect(NOISE_ZIPS).toContain(TEST_ZIP);
  });
});

describe("refreshOverflightRollup", () => {
  it("counts distinct aircraft intersecting the zip polygon, aggregating altitude", async () => {
    const date = "2026-03-10";
    const hour = laHourToUnixSeconds(date, 8);

    await insertPositions([
      state("in00001", INSIDE.lat, INSIDE.lon, hour, 1000),
      state("in00002", INSIDE.lat, INSIDE.lon, hour, 2000),
      state("out0001", OUTSIDE.lat, OUTSIDE.lon, hour, 5000), // outside the polygon
    ]);

    await refreshOverflightRollup(pool, [date]);

    const rows = await pool.query(
      `SELECT overflights, altitude_sum, altitude_count, min_altitude
       FROM overflight_hourly_counts WHERE zcta5 = $1 AND date = $2 AND hour = $3`,
      [TEST_ZIP, date, 8],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      overflights: 2,
      altitude_sum: 3000,
      altitude_count: 2,
      min_altitude: 1000,
    });
  });

  it("does not create a row for a zip with no intersecting positions", async () => {
    const date = "2026-03-12";
    const hour = laHourToUnixSeconds(date, 8);
    await insertPositions([state("nomatch1", OUTSIDE.lat, OUTSIDE.lon, hour, 4000)]);

    await refreshOverflightRollup(pool, [date]);

    const rows = await pool.query(
      "SELECT 1 FROM overflight_hourly_counts WHERE zcta5 = $1 AND date = $2",
      [TEST_ZIP, date],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("is a no-op for an empty dates array", async () => {
    await expect(refreshOverflightRollup(pool, [])).resolves.toBeUndefined();
  });
});
