import type pg from "pg";
import {
  APPROACH_ALT_MARGIN_M,
  CLIMB_DESCENT_THRESHOLD_MS,
  GLIDESLOPE_M_PER_KM,
  REGIONAL_AIRPORTS,
} from "../enrichment/regionalAirports.js";

// Per-airport attribution deliberately mirrors inferFlightPhase()
// (enrichment/regionalAirports.ts), which is what the flow badge already
// uses. It can't be called directly here — that works on live StateVectors,
// this scores stored `positions` rows — so the same three rules are
// expressed in SQL against the columns postgres.ts writes
// (altitude = geoAltitude ?? baroAltitude, vertical_speed = verticalRate):
//
//   1. NEAREST FIELD WINS. Previously a row counted for *every* airport whose
//      radius contained it. KSEA/KBFI/KRNT sit 7.6-8.9km apart with 25/12/8km
//      radii, so each field's reference point falls inside its neighbours'
//      circles — a single SEA arrival was counted as traffic at all three,
//      inflating the two small fields far more than SEA (they have less real
//      traffic for the leak to hide in).
//   2. DISTANCE-AWARE ALTITUDE GATE. Previously absent entirely, so an
//      airliner cruising over Seattle at 10,000m counted as Boeing Field
//      traffic. Allowed altitude grows with distance to model an approach
//      path: ~600m at 5km out, ~1800m at the 25km edge.
//   3. CLIMBING OR DESCENDING. Level flight through the corridor is a
//      transit, not an operation. Counts are COUNT(DISTINCT icao24) per
//      day/hour, so an aircraft that genuinely operated at a field only needs
//      one qualifying sample — it will have many.
//
// The gate is applied BEFORE nearest-wins on purpose: an aircraft descending
// into SEA over the top of BFI fails BFI's tighter ceiling but passes SEA's,
// and should count for SEA rather than being discarded because BFI happened
// to be closer.
//
// REGION is deliberately left ungated — "distinct aircraft seen anywhere in
// the coverage area" is a different question, and correct as it was. Airport
// scopes therefore do not sum to REGION, the same way hourly rows don't sum
// to their daily row (see docs/rollup-tables.md).
const AIRPORT_SCOPES = REGIONAL_AIRPORTS.map((a) => a.icao);
const AIRPORT_LATS = REGIONAL_AIRPORTS.map((a) => a.lat);
const AIRPORT_LONS = REGIONAL_AIRPORTS.map((a) => a.lon);
const AIRPORT_RADII_M = REGIONAL_AIRPORTS.map((a) => a.approachRadiusKm * 1000);

// Shared by the daily and hourly upserts. Emits one row per stored position
// that looks like an operation, attributed to exactly one field.
const ATTRIBUTION_CTE = `
  airports AS (
    SELECT * FROM unnest($4::text[], $5::float8[], $6::float8[], $7::float8[])
      AS t(scope, lat, lon, radius_m)
  ),
  near AS (
    SELECT p.id, p.icao24, p.recorded_at, p.altitude, a.scope,
           ST_Distance(p.position, ST_MakePoint(a.lon, a.lat)::geography) AS dist_m
    FROM positions p
    JOIN airports a
      ON ST_DWithin(p.position, ST_MakePoint(a.lon, a.lat)::geography, a.radius_m)
    WHERE p.recorded_at >= $1 AND p.recorded_at < $2
      AND p.altitude IS NOT NULL
      AND p.vertical_speed IS NOT NULL
      AND abs(p.vertical_speed) >= $10
  ),
  attributed AS (
    SELECT DISTINCT ON (id) id, icao24, recorded_at, scope
    FROM near
    WHERE altitude <= $8 + $9 * (dist_m / 1000.0)
    ORDER BY id, dist_m
  )`;

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

// Both upserts write a row for every (scope, date[, hour]) combination in
// range, defaulting to 0 via the grid LEFT JOIN rather than emitting nothing.
// A pure "insert what we counted" upsert would leave a previously-written
// higher number in place whenever a combination legitimately drops to zero —
// which is exactly what the stricter attribution above now causes for the
// small fields. Writing explicit zeroes keeps the tables self-healing without
// a DELETE, so this stays a plain upsert and safe to run concurrently.
function queryParams(start: Date, end: Date, dates: string[]): unknown[] {
  return [
    start, end, dates,
    AIRPORT_SCOPES, AIRPORT_LATS, AIRPORT_LONS, AIRPORT_RADII_M,
    APPROACH_ALT_MARGIN_M, GLIDESLOPE_M_PER_KM, CLIMB_DESCENT_THRESHOLD_MS,
  ];
}

async function upsertDaily(
  client: pg.PoolClient,
  start: Date,
  end: Date,
  dates: string[],
): Promise<void> {
  await client.query(
    `WITH ${ATTRIBUTION_CTE},
     counts AS (
       SELECT scope, (recorded_at AT TIME ZONE 'America/Los_Angeles')::date AS date,
              COUNT(DISTINCT icao24) AS flights
       FROM attributed GROUP BY 1, 2
       UNION ALL
       SELECT 'REGION', (p.recorded_at AT TIME ZONE 'America/Los_Angeles')::date,
              COUNT(DISTINCT p.icao24)
       FROM positions p
       WHERE p.recorded_at >= $1 AND p.recorded_at < $2
       GROUP BY 2
     ),
     grid AS (
       SELECT s.scope, d.date
       FROM unnest($4::text[] || ARRAY['REGION']) AS s(scope)
       CROSS JOIN unnest($3::date[]) AS d(date)
     )
     INSERT INTO traffic_daily_counts (scope, date, flights)
     SELECT g.scope, g.date, COALESCE(c.flights, 0)
     FROM grid g
     LEFT JOIN counts c ON c.scope = g.scope AND c.date = g.date
     ON CONFLICT (scope, date) DO UPDATE SET flights = EXCLUDED.flights`,
    queryParams(start, end, dates),
  );
}

async function upsertHourly(
  client: pg.PoolClient,
  start: Date,
  end: Date,
  dates: string[],
): Promise<void> {
  await client.query(
    `WITH ${ATTRIBUTION_CTE},
     counts AS (
       SELECT scope, (recorded_at AT TIME ZONE 'America/Los_Angeles')::date AS date,
              EXTRACT(HOUR FROM recorded_at AT TIME ZONE 'America/Los_Angeles')::int AS hour,
              COUNT(DISTINCT icao24) AS flights
       FROM attributed GROUP BY 1, 2, 3
       UNION ALL
       SELECT 'REGION', (p.recorded_at AT TIME ZONE 'America/Los_Angeles')::date,
              EXTRACT(HOUR FROM p.recorded_at AT TIME ZONE 'America/Los_Angeles')::int,
              COUNT(DISTINCT p.icao24)
       FROM positions p
       WHERE p.recorded_at >= $1 AND p.recorded_at < $2
       GROUP BY 2, 3
     ),
     grid AS (
       SELECT s.scope, d.date, h.hour
       FROM unnest($4::text[] || ARRAY['REGION']) AS s(scope)
       CROSS JOIN unnest($3::date[]) AS d(date)
       CROSS JOIN generate_series(0, 23) AS h(hour)
     )
     INSERT INTO traffic_hourly_counts (scope, date, hour, flights)
     SELECT g.scope, g.date, g.hour, COALESCE(c.flights, 0)
     FROM grid g
     LEFT JOIN counts c ON c.scope = g.scope AND c.date = g.date AND c.hour = g.hour
     ON CONFLICT (scope, date, hour) DO UPDATE SET flights = EXCLUDED.flights`,
    queryParams(start, end, dates),
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
    await upsertDaily(client, start, end, dates);
    await upsertHourly(client, start, end, dates);
  } finally {
    await client.query("SET statement_timeout = DEFAULT").catch(() => {});
    client.release();
  }
}
