import pg from "pg";
import { config } from "../config.js";
import type { StateVector } from "../openskyClient.js";

export const pool = new pg.Pool({ connectionString: config.postgres.connectionString });

export async function insertPositions(states: StateVector[]): Promise<void> {
  if (states.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const s of states) {
      // aircraft upsert must happen first — positions.icao24 has an FK to aircraft
      await client.query(
        `INSERT INTO aircraft (icao24, first_seen, last_seen)
         VALUES ($1, now(), now())
         ON CONFLICT (icao24) DO UPDATE SET last_seen = now()`,
        [s.icao24],
      );
      await client.query(
        `INSERT INTO positions
           (icao24, callsign, position, altitude, ground_speed, heading, vertical_speed, recorded_at)
         VALUES
           ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5, $6, $7, $8, to_timestamp($9))`,
        [
          s.icao24,
          s.callsign,
          s.longitude,
          s.latitude,
          s.geoAltitude ?? s.baroAltitude,
          s.velocity,
          s.trueTrack,
          s.verticalRate,
          s.lastContact,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
