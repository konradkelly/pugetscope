import type pg from "pg";

// Curated "noise-relevant" zips only — mirrors NeighborhoodAnalyticsPanel.tsx's
// ZIP_OPTIONS (frontend) — not shared as a package per this repo's convention
// (see trafficRollup.ts's REGIONAL_AIRPORTS comment for the same rationale).
// zip_boundaries has ~217 loaded ZCTAs total (docs/SPEC.md §13), but only
// these 6 are ever surfaced by the product, so the rollup — like traffic's
// rollup scoping to 5 named airports + 'REGION' rather than every possible
// spatial area — stays bounded to what's actually queried.
export const NOISE_ZIPS = ["98108", "98146", "98158", "98168", "98188", "98198"];

// Same conservative UTC padding as trafficRollup.ts's utcRangeForLaDates —
// duplicated rather than imported, per this repo's no-shared-package
// convention (see that file for the full DST rationale).
function utcRangeForLaDates(dates: string[]): { start: Date; end: Date } {
  const sorted = [...dates].sort();
  const minDate = sorted[0];
  const maxDate = sorted[sorted.length - 1];

  const start = new Date(`${minDate}T00:00:00-08:00`);
  start.setUTCHours(start.getUTCHours() - 1);

  const end = new Date(`${maxDate}T00:00:00-07:00`);
  end.setUTCDate(end.getUTCDate() + 1);
  end.setUTCHours(end.getUTCHours() + 1);

  return { start, end };
}

// Small window (poll-loop's "today + yesterday" case) — same rationale/value
// as trafficRollup.ts's DEFAULT_STATEMENT_TIMEOUT_MS.
const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;

// Recomputes overflight_hourly_counts for the given (contiguous) LA calendar
// dates, across all of NOISE_ZIPS in one query (ST_Intersects against
// zip_boundaries naturally covers multiple polygons per pass, unlike
// trafficRollup.ts's per-airport ST_DWithin-from-a-point loop, so no
// per-zip looping is needed here).
//
// Invariant, same as trafficRollup.ts's: nothing besides this function and
// the poll loop's "today + yesterday" call ever re-touches a date's rollup.
// Any future code path that inserts historical `positions` rows must also
// re-run this for those dates, or their rollups go stale.
export async function refreshOverflightRollup(
  pool: pg.Pool,
  dates: string[],
  statementTimeoutMs: number = DEFAULT_STATEMENT_TIMEOUT_MS,
): Promise<void> {
  if (dates.length === 0) return;
  const { start, end } = utcRangeForLaDates(dates);

  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = ${statementTimeoutMs}`);
    await client.query(
      `INSERT INTO overflight_hourly_counts
         (zcta5, date, hour, overflights, altitude_sum, altitude_count, min_altitude)
       SELECT
         z.zcta5,
         (p.recorded_at AT TIME ZONE 'America/Los_Angeles')::date AS date,
         EXTRACT(HOUR FROM p.recorded_at AT TIME ZONE 'America/Los_Angeles')::int AS hour,
         COUNT(DISTINCT p.icao24) AS overflights,
         COALESCE(SUM(p.altitude), 0) AS altitude_sum,
         COUNT(p.altitude) AS altitude_count,
         MIN(p.altitude) AS min_altitude
       FROM positions p
       JOIN zip_boundaries z ON ST_Intersects(p.position, z.boundary)
       WHERE p.recorded_at >= $1 AND p.recorded_at < $2
         AND z.zcta5 = ANY($3)
       GROUP BY z.zcta5, date, hour
       ON CONFLICT (zcta5, date, hour) DO UPDATE SET
         overflights = EXCLUDED.overflights,
         altitude_sum = EXCLUDED.altitude_sum,
         altitude_count = EXCLUDED.altitude_count,
         min_altitude = EXCLUDED.min_altitude`,
      [start, end, NOISE_ZIPS],
    );
  } finally {
    await client.query("SET statement_timeout = DEFAULT").catch(() => {});
    client.release();
  }
}
