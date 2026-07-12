import { pool } from "./postgres.js";
import type { FidsFlight } from "../enrichment/fidsClient.js";

export async function getLastFetchedAt(airportIcao: string): Promise<Date | null> {
  const result = await pool.query<{ last_fetched_at: Date }>(
    "SELECT last_fetched_at FROM fids_refresh_state WHERE airport_icao = $1",
    [airportIcao],
  );
  return result.rows[0]?.last_fetched_at ?? null;
}

export async function replaceBoard(airportIcao: string, flights: FidsFlight[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Full replace rather than merge: a 12h window fetched fresh each time
    // fully describes the current board, so stale rows (e.g. a flight that
    // fell out of the window) should disappear too.
    await client.query("DELETE FROM fids_flights WHERE airport_icao = $1", [airportIcao]);
    for (const f of flights) {
      await client.query(
        `INSERT INTO fids_flights
           (airport_icao, direction, call_sign, flight_number, status, airline_name,
            other_icao, other_iata, other_name, other_lat, other_lon,
            scheduled_time, revised_time, fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
         ON CONFLICT (airport_icao, direction, call_sign) DO UPDATE SET
           flight_number = EXCLUDED.flight_number,
           status = EXCLUDED.status,
           airline_name = EXCLUDED.airline_name,
           other_icao = EXCLUDED.other_icao, other_iata = EXCLUDED.other_iata,
           other_name = EXCLUDED.other_name, other_lat = EXCLUDED.other_lat,
           other_lon = EXCLUDED.other_lon,
           scheduled_time = EXCLUDED.scheduled_time,
           revised_time = EXCLUDED.revised_time,
           fetched_at = now()`,
        [
          airportIcao, f.direction, f.callSign, f.flightNumber, f.status, f.airlineName,
          f.other.icao, f.other.iata, f.other.name, f.other.lat, f.other.lon,
          f.scheduledTime, f.revisedTime,
        ],
      );
    }
    await client.query(
      `INSERT INTO fids_refresh_state (airport_icao, last_fetched_at)
       VALUES ($1, now())
       ON CONFLICT (airport_icao) DO UPDATE SET last_fetched_at = now()`,
      [airportIcao],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface FidsMatch {
  direction: "departure" | "arrival";
  status: string;
  airlineName: string | null;
  homeIcao: string; // the airport this board belongs to (e.g. KSEA)
  other: {
    icao: string | null; iata: string | null; name: string | null;
    lat: number | null; lon: number | null;
  };
  scheduledTime: Date | null;
  revisedTime: Date | null;
}

/** Batched lookup of FIDS matches for a set of callsigns, mirroring
 * getFreshRoutes' shape in flightRoutes.ts. A callsign should appear as
 * either a departure or an arrival at a given airport within one board
 * window, not both, so at most one match per callsign is returned. */
export async function findFidsMatches(callsigns: string[]): Promise<Map<string, FidsMatch>> {
  const map = new Map<string, FidsMatch>();
  if (callsigns.length === 0) return map;

  const result = await pool.query(
    `SELECT DISTINCT ON (call_sign)
            call_sign, airport_icao, direction, status, airline_name,
            other_icao, other_iata, other_name, other_lat, other_lon,
            scheduled_time, revised_time
     FROM fids_flights
     WHERE call_sign = ANY($1)`,
    [callsigns],
  );

  for (const row of result.rows) {
    map.set(row.call_sign, {
      direction: row.direction,
      status: row.status,
      airlineName: row.airline_name,
      homeIcao: row.airport_icao,
      other: {
        icao: row.other_icao, iata: row.other_iata, name: row.other_name,
        lat: row.other_lat, lon: row.other_lon,
      },
      scheduledTime: row.scheduled_time,
      revisedTime: row.revised_time,
    });
  }
  return map;
}
