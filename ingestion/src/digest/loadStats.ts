import type pg from "pg";
import { REGIONAL_AIRPORTS } from "../enrichment/regionalAirports.js";
import type { DigestStats, NotableAircraft } from "./format.js";

// Reads yesterday's already-rolled-up traffic_daily_counts (docs/rollup-tables.md)
// rather than positions directly — cheap, proven, no new query shape. The pool
// is a parameter rather than a module import, matching refreshTrafficRollup()'s
// signature, so the REGION guard below is testable without a live database.

const NOTABLE_AIRCRAFT_LIMIT = 5;

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

  const [vsLastWeek, busiestHour, notableAircraft] = await Promise.all([
    loadVsLastWeek(pool, date),
    loadBusiestHour(pool, date),
    loadNotableAircraft(pool, date),
  ]);

  return { date, totalFlights: region, byAirport, vsLastWeek, busiestHour, notableAircraft };
}
