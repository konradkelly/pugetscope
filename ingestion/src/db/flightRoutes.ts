import { pool } from "./postgres.js";
import type { FlightRoute, LookupResult } from "../enrichment/adsbdbClient.js";

// Cache freshness windows (see docs/SPEC.md §12): routes change slowly, so
// positive hits live a long time; misses are re-checkable sooner in case a
// callsign later becomes a resolvable airline flight.
const POSITIVE_TTL = "14 days";
const NEGATIVE_TTL = "6 hours";

export interface CachedRoute {
  callsign: string;
  found: boolean;
  route: FlightRoute | null;
}

/**
 * Reads cached routes for the given callsigns that are still fresh. Stale or
 * absent callsigns are simply omitted from the returned map, signalling the
 * caller to (re)enqueue a lookup.
 */
export async function getFreshRoutes(callsigns: string[]): Promise<Map<string, CachedRoute>> {
  const map = new Map<string, CachedRoute>();
  if (callsigns.length === 0) return map;

  const result = await pool.query(
    `SELECT * FROM flight_routes
     WHERE callsign = ANY($1)
       AND (
         (found = true  AND fetched_at > now() - $2::interval) OR
         (found = false AND fetched_at > now() - $3::interval)
       )`,
    [callsigns, POSITIVE_TTL, NEGATIVE_TTL],
  );

  for (const row of result.rows) {
    map.set(row.callsign, {
      callsign: row.callsign,
      found: row.found,
      route: row.found
        ? {
            airline: row.airline_name,
            origin: {
              icao: row.origin_icao, iata: row.origin_iata, name: row.origin_name,
              lat: row.origin_lat, lon: row.origin_lon,
            },
            destination: {
              icao: row.dest_icao, iata: row.dest_iata, name: row.dest_name,
              lat: row.dest_lat, lon: row.dest_lon,
            },
          }
        : null,
    });
  }
  return map;
}

export async function upsertRoute(callsign: string, result: LookupResult): Promise<void> {
  const o = result.found ? result.route.origin : null;
  const d = result.found ? result.route.destination : null;
  await pool.query(
    `INSERT INTO flight_routes
       (callsign, found, airline_name,
        origin_icao, origin_iata, origin_name, origin_lat, origin_lon,
        dest_icao, dest_iata, dest_name, dest_lat, dest_lon, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     ON CONFLICT (callsign) DO UPDATE SET
       found = EXCLUDED.found,
       airline_name = EXCLUDED.airline_name,
       origin_icao = EXCLUDED.origin_icao, origin_iata = EXCLUDED.origin_iata,
       origin_name = EXCLUDED.origin_name, origin_lat = EXCLUDED.origin_lat,
       origin_lon = EXCLUDED.origin_lon,
       dest_icao = EXCLUDED.dest_icao, dest_iata = EXCLUDED.dest_iata,
       dest_name = EXCLUDED.dest_name, dest_lat = EXCLUDED.dest_lat,
       dest_lon = EXCLUDED.dest_lon,
       fetched_at = now()`,
    [
      callsign,
      result.found,
      result.found ? result.route.airline : null,
      o?.icao ?? null, o?.iata ?? null, o?.name ?? null, o?.lat ?? null, o?.lon ?? null,
      d?.icao ?? null, d?.iata ?? null, d?.name ?? null, d?.lat ?? null, d?.lon ?? null,
    ],
  );
}
