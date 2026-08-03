import pg from "pg";
import { config } from "../config.js";
import type { StateVector } from "../openskyClient.js";

// Hot path: insertPositions (below), attachAircraftType, and the FIDS
// refresh worker — all low-concurrency (the poll loop is sequential), so
// this only needs headroom for a couple of overlapping calls, not pg's
// default max of 10.
export const pool = new pg.Pool({
  connectionString: config.postgres.connectionString,
  ssl: config.postgres.ssl,
  max: 5,
});

// Separate, smaller pool for the traffic/overflight rollup refreshes only.
// Each refresh holds one client for the whole query (a multi-second
// ST_Intersects/ST_DWithin scan) — on the shared `pool` above, that meant a
// slow rollup query could tie up a connection insertPositions also needed,
// right on the every-30s critical path. At most 2 concurrent uses (traffic +
// overflight; each already serialized against itself via its own in-flight
// guard in index.ts), so max: 2 is sized to exactly that, not shared budget.
export const rollupPool = new pg.Pool({
  connectionString: config.postgres.connectionString,
  ssl: config.postgres.ssl,
  max: 2,
});

// Without this, a network error on an idle client (e.g. RDS dropping a
// connection) is an unhandled 'error' event and crashes the process.
for (const p of [pool, rollupPool]) {
  p.on("error", (err) => {
    console.error("[postgres] idle client error:", err);
  });
}

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
