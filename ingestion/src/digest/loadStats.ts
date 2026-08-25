import type pg from "pg";
import { REGIONAL_AIRPORTS } from "../enrichment/regionalAirports.js";
import type { AirlineHighlight, DelayHighlight, DigestStats, FlightHighlight, NotableAircraft } from "./format.js";

// Reads yesterday's already-rolled-up traffic_daily_counts (docs/rollup-tables.md)
// rather than positions directly — cheap, proven, no new query shape. The pool
// is a parameter rather than a module import, matching refreshTrafficRollup()'s
// signature, so the REGION guard below is testable without a live database.

// Exported so the test suite can assert against the real constant rather
// than duplicating the magic number.
export const NOTABLE_AIRCRAFT_LIMIT = 5;

async function loadVsLastWeek(pool: pg.Pool, date: string): Promise<number | null> {
  const { rows } = await pool.query<{ flights: number }>(
    `SELECT flights FROM traffic_daily_counts
     WHERE scope = 'REGION' AND date = ($1::date - interval '7 days')::date`,
    [date],
  );
  return rows[0] ? Number(rows[0].flights) : null;
}

async function loadBusiestHour(pool: pg.Pool, date: string): Promise<number | null> {
  const { rows } = await pool.query<{ hour: number }>(
    `SELECT hour FROM traffic_hourly_counts
     WHERE scope = 'REGION' AND date = $1
     ORDER BY flights DESC
     LIMIT 1`,
    [date],
  );
  return rows[0] ? Number(rows[0].hour) : null;
}

// This filter combination only surfaces anything if `typecode` is already
// populated by the time *this exact date's* digest runs — `first_seen` is a
// one-shot match (an aircraft only ever has one calendar day where this WHERE
// clause can match it), so enrichment can't lag behind on a "catch up later"
// basis the way it can for every other consumer of the `aircraft` table.
// This used to be true in practice: aircraft-database enrichment
// (`ingestion/src/enrich.ts`) was manual-only (`npm run enrich`), so a
// same-day enrichment run essentially never happened and this stayed empty.
// Fixed by k8s/base/aircraft-enrich-cronjob.yaml (0 9 * * *, ahead of
// digest-generate's 0 10 * * *) — keep that CronJob's schedule ahead of
// digest-generate's if either one ever moves.
async function loadNotableAircraft(pool: pg.Pool, date: string): Promise<NotableAircraft[]> {
  const { rows } = await pool.query<NotableAircraft>(
    `SELECT icao24, registration, manufacturer, model, typecode, operator
     FROM aircraft
     WHERE (first_seen AT TIME ZONE 'America/Los_Angeles')::date = $1::date
       AND typecode IS NOT NULL
     ORDER BY icao24
     LIMIT ${NOTABLE_AIRCRAFT_LIMIT}`,
    [date],
  );
  return rows;
}

// §17.3 — busiest airline this date, from fids_daily_rollup (docs/SPEC.md
// §17.3, db/init/001_schema.sql). Empty/absent whenever FIDS enrichment
// isn't configured, matching the other optional facts' null-not-zero posture.
async function loadBusiestAirline(pool: pg.Pool, date: string): Promise<AirlineHighlight | null> {
  const { rows } = await pool.query<{ airline_name: string; flights: number }>(
    `SELECT airline_name, COUNT(*) AS flights
     FROM fids_daily_rollup
     WHERE date = $1 AND airline_name IS NOT NULL
     GROUP BY airline_name
     ORDER BY flights DESC, airline_name
     LIMIT 1`,
    [date],
  );
  const row = rows[0];
  return row ? { airlineName: row.airline_name, flights: Number(row.flights) } : null;
}

interface FlightHighlightRow {
  call_sign: string;
  flight_number: string | null;
  airline_name: string | null;
  airport_icao: string;
  direction: "departure" | "arrival";
  other_name: string | null;
}

function toFlightHighlight(row: FlightHighlightRow): FlightHighlight {
  return {
    callSign: row.call_sign,
    flightNumber: row.flight_number,
    airlineName: row.airline_name,
    airportIcao: row.airport_icao,
    direction: row.direction,
    otherName: row.other_name,
  };
}

// §17.3 — largest scheduled-vs-revised gap captured this date.
// `revised_time > scheduled_time` excludes early/on-time flights (a negative
// or zero gap is not a delay) rather than just sorting on it, so an entirely
// on-time day correctly yields null instead of its least-early flight.
async function loadLongestDelay(pool: pg.Pool, date: string): Promise<DelayHighlight | null> {
  const { rows } = await pool.query<FlightHighlightRow & { delay_minutes: number }>(
    `SELECT call_sign, flight_number, airline_name, airport_icao, direction, other_name,
            EXTRACT(EPOCH FROM (revised_time - scheduled_time)) / 60 AS delay_minutes
     FROM fids_daily_rollup
     WHERE date = $1 AND scheduled_time IS NOT NULL AND revised_time IS NOT NULL
       AND revised_time > scheduled_time
     ORDER BY delay_minutes DESC
     LIMIT 1`,
    [date],
  );
  const row = rows[0];
  return row ? { ...toFlightHighlight(row), delayMinutes: Math.round(Number(row.delay_minutes)) } : null;
}

// §17.3 — first captured flight this date whose status mentions a diversion.
// AeroDataBox's status vocabulary isn't formally documented, so this matches
// loosely on substring rather than an exact enum of expected values.
async function loadNotableDiversion(pool: pg.Pool, date: string): Promise<FlightHighlight | null> {
  const { rows } = await pool.query<FlightHighlightRow>(
    `SELECT call_sign, flight_number, airline_name, airport_icao, direction, other_name
     FROM fids_daily_rollup
     WHERE date = $1 AND status ILIKE '%divert%'
     ORDER BY call_sign
     LIMIT 1`,
    [date],
  );
  const row = rows[0];
  return row ? toFlightHighlight(row) : null;
}

export async function loadStats(pool: pg.Pool, date: string): Promise<DigestStats> {
  const { rows } = await pool.query<{ scope: string; flights: number }>(
    `SELECT scope, flights FROM traffic_daily_counts WHERE date = $1`,
    [date],
  );
  const byScope = new Map(rows.map((r) => [r.scope, Number(r.flights)]));

  // No REGION row means the rollup hasn't run for this date yet — don't
  // publish a wrong "0 flights" digest, fail loudly instead. A present
  // REGION row with flights: 0 is a genuinely quiet day and fine to use.
  const region = byScope.get("REGION");
  if (region === undefined) {
    throw new Error(`no REGION traffic_daily_counts row for ${date} — rollup likely hasn't run yet`);
  }

  const byAirport: Record<string, number> = {};
  for (const airport of REGIONAL_AIRPORTS) {
    byAirport[airport.icao] = byScope.get(airport.icao) ?? 0;
  }

  const [vsLastWeek, busiestHour, notableAircraft, busiestAirline, longestDelay, notableDiversion] =
    await Promise.all([
      loadVsLastWeek(pool, date),
      loadBusiestHour(pool, date),
      loadNotableAircraft(pool, date),
      loadBusiestAirline(pool, date),
      loadLongestDelay(pool, date),
      loadNotableDiversion(pool, date),
    ]);

  return {
    date,
    totalFlights: region,
    byAirport,
    vsLastWeek,
    busiestHour,
    notableAircraft,
    busiestAirline,
    longestDelay,
    notableDiversion,
  };
}
