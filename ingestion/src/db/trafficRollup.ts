import type pg from "pg";
import { REGIONAL_AIRPORTS } from "../enrichment/regionalAirports.js";

// Mirrors REGIONAL_AIRPORTS (icao/lat/lon/approachRadiusKm) plus a spatial-
// filter-free 'REGION' scope — see api/src/routes/traffic.ts's own
// REGIONAL_AIRPORTS for why this list isn't shared as a package.
interface RollupScope {
  scope: string;
  spatial: { lat: number; lon: number; radiusM: number } | null;
}

const ROLLUP_SCOPES: RollupScope[] = [
  ...REGIONAL_AIRPORTS.map((a) => ({
    scope: a.icao,
    spatial: { lat: a.lat, lon: a.lon, radiusM: a.approachRadiusKm * 1000 },
  })),
  { scope: "REGION", spatial: null },
];

// Conservative UTC padding around the requested LA calendar-date range,
// rather than exact DST-aware boundary math: Pacific time is either UTC-7
// (PDT) or UTC-8 (PST), so padding 1h beyond the wider offset on each side
// guarantees the range fully covers the requested dates regardless of DST.
// This WHERE-clause range only needs to be a superset — the exact per-row
// LA-day (and hour) bucketing happens in SQL via `AT TIME ZONE
// 'America/Los_Angeles'` in the SELECT/GROUP BY below, so a few extra edge
// rows just get read and then correctly excluded, never counted wrong.
// Exported for unit testing (trafficRollup.test.ts) — the DST-padding math
// is the one part of this file worth covering without a real Postgres.
export function utcRangeForLaDates(dates: string[]): { start: Date; end: Date } {
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

async function upsertDaily(
  client: pg.PoolClient,
  { scope, spatial }: RollupScope,
  start: Date,
  end: Date,
): Promise<void> {
  const spatialFilter = spatial ? "AND ST_DWithin(p.position, ST_MakePoint($4, $5)::geography, $6)" : "";
  const params = spatial
    ? [scope, start, end, spatial.lon, spatial.lat, spatial.radiusM]
    : [scope, start, end];

  await client.query(
    `INSERT INTO traffic_daily_counts (scope, date, flights)
     SELECT $1, (p.recorded_at AT TIME ZONE 'America/Los_Angeles')::date AS date,
            COUNT(DISTINCT p.icao24) AS flights
     FROM positions p
     WHERE p.recorded_at >= $2 AND p.recorded_at < $3
       ${spatialFilter}
     GROUP BY date
     ON CONFLICT (scope, date) DO UPDATE SET flights = EXCLUDED.flights`,
    params,
  );
}

async function upsertHourly(
  client: pg.PoolClient,
  { scope, spatial }: RollupScope,
  start: Date,
  end: Date,
): Promise<void> {
  const spatialFilter = spatial ? "AND ST_DWithin(p.position, ST_MakePoint($4, $5)::geography, $6)" : "";
  const params = spatial
    ? [scope, start, end, spatial.lon, spatial.lat, spatial.radiusM]
    : [scope, start, end];

  await client.query(
    `INSERT INTO traffic_hourly_counts (scope, date, hour, flights)
     SELECT $1, (p.recorded_at AT TIME ZONE 'America/Los_Angeles')::date AS date,
            EXTRACT(HOUR FROM p.recorded_at AT TIME ZONE 'America/Los_Angeles')::int AS hour,
            COUNT(DISTINCT p.icao24) AS flights
     FROM positions p
     WHERE p.recorded_at >= $2 AND p.recorded_at < $3
       ${spatialFilter}
     GROUP BY date, hour
     ON CONFLICT (scope, date, hour) DO UPDATE SET flights = EXCLUDED.flights`,
    params,
  );
}

// Small window (poll-loop's "today + yesterday" case): tight enough to
// never meaningfully hold a connection on the dedicated `rollupPool`
// (db/postgres.ts), separate from insertPositions's writes.
const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;

// Recomputes traffic_daily_counts/traffic_hourly_counts for the given
// (contiguous) LA calendar dates, for every airport + the region-wide scope.
// Throws on failure — callers decide whether/how to swallow that (the poll
// loop logs and moves on; the one-time backfill script wants a real exit
// code).
//
// `statementTimeoutMs` defaults to a tight safety net sized for the small
// incremental case above — the one-time backfill script (potentially dozens
// of historical dates in one range) must pass a much larger value, or its
// first query past 5s gets cancelled exactly like the original per-request
// `positions` scans this migration exists to replace.
//
// Invariant: nothing besides this function and the poll loop's "today +
// yesterday" call ever re-touches a date's rollup. Any future code path that
// inserts historical `positions` rows (a replay tool, a manual backfill,
// etc.) must also re-run this for those dates, or their rollups go stale.
export async function refreshTrafficRollup(
  pool: pg.Pool,
  dates: string[],
  statementTimeoutMs: number = DEFAULT_STATEMENT_TIMEOUT_MS,
): Promise<void> {
  if (dates.length === 0) return;
  const { start, end } = utcRangeForLaDates(dates);

  const client = await pool.connect();
  try {
    // A single reserved client for the whole refresh keeps this to one pool
    // connection regardless of statementTimeoutMs.
    await client.query(`SET statement_timeout = ${statementTimeoutMs}`);
    for (const rollupScope of ROLLUP_SCOPES) {
      await upsertDaily(client, rollupScope, start, end);
      await upsertHourly(client, rollupScope, start, end);
    }
  } finally {
    await client.query("SET statement_timeout = DEFAULT").catch(() => {});
    client.release();
  }
}
