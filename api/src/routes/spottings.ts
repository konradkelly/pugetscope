import type { FastifyInstance } from "fastify";
import { pool } from "../db/postgres.js";
import { getCurrentUserId } from "../auth/session.js";

const ICAO24_RE = /^[0-9a-f]{6}$/i;

// How far back an aircraft still counts as "currently in range" for
// confirmation purposes — a little slack past the ~30s ingestion poll
// cadence for request latency.
const CONFIRM_LOOKBACK_MINUTES = 3;

// Re-logging the same aircraft within this window is treated as the same
// sighting (double-clicks, re-opening the panel) rather than a new entry.
const DUPLICATE_COOLDOWN_MINUTES = 60;

interface RecentPositionRow {
  recorded_at: string;
  altitude: number | null;
  lat: number;
  lon: number;
}

interface SpottingRow {
  id: number;
  spotted_at: string;
}

interface LifeListRow {
  icao24: string;
  times_spotted: string;
  first_spotted_at: string;
  last_spotted_at: string;
  sightings: { id: number; spottedAt: string }[];
  registration: string | null;
  manufacturer: string | null;
  model: string | null;
  operator: string | null;
}

export async function spottingsRoutes(app: FastifyInstance): Promise<void> {
  // Log a sighting — auto-confirmed against a real `positions` row rather
  // than trusting the client's claim, so this reads as a logbook, not a
  // self-reported list. Idempotent within DUPLICATE_COOLDOWN_MINUTES.
  app.post<{ Body: { icao24?: string } }>("/spottings", async (request, reply) => {
    const userId = await getCurrentUserId(request);
    if (!userId) return reply.code(401).send({ error: "log in to keep a spotting log" });

    const icao24 = request.body?.icao24?.toLowerCase();
    if (!icao24 || !ICAO24_RE.test(icao24)) {
      return reply.code(400).send({ error: "icao24 must be a 6-character hex code" });
    }

    const recent = await pool.query<RecentPositionRow>(
      `SELECT recorded_at, altitude,
              ST_Y(position::geometry) AS lat, ST_X(position::geometry) AS lon
       FROM positions
       WHERE icao24 = $1 AND recorded_at >= now() - ($2 || ' minutes')::interval
       ORDER BY recorded_at DESC
       LIMIT 1`,
      [icao24, CONFIRM_LOOKBACK_MINUTES],
    );
    const confirmation = recent.rows[0];
    if (!confirmation) {
      return reply
        .code(404)
        .send({ error: "not currently in range — nothing to confirm this sighting against" });
    }

    const existing = await pool.query<SpottingRow>(
      `SELECT id, spotted_at FROM spottings
       WHERE user_id = $1 AND icao24 = $2
       ORDER BY spotted_at DESC
       LIMIT 1`,
      [userId, icao24],
    );
    const last = existing.rows[0];
    const isFirstSighting = !last;
    if (last && Date.now() - new Date(last.spotted_at).getTime() < DUPLICATE_COOLDOWN_MINUTES * 60_000) {
      return reply.send({
        id: last.id,
        icao24,
        spottedAt: last.spotted_at,
        duplicate: true,
        isFirstSighting: false,
      });
    }

    const inserted = await pool.query<SpottingRow>(
      `INSERT INTO spottings (user_id, icao24, spotted_at, latitude, longitude, altitude)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, spotted_at`,
      [userId, icao24, confirmation.recorded_at, confirmation.lat, confirmation.lon, confirmation.altitude],
    );

    return reply.code(201).send({
      id: inserted.rows[0].id,
      icao24,
      spottedAt: inserted.rows[0].spotted_at,
      duplicate: false,
      isFirstSighting,
    });
  });

  // The life-list view: one row per aircraft ever spotted, not one row per
  // sighting event — that's the shape a logbook is actually read in.
  app.get("/spottings", async (request, reply) => {
    const userId = await getCurrentUserId(request);
    if (!userId) return reply.code(401).send({ error: "log in to view your spotting log" });

    const result = await pool.query<LifeListRow>(
      `SELECT s.icao24,
              count(*) AS times_spotted,
              min(s.spotted_at) AS first_spotted_at,
              max(s.spotted_at) AS last_spotted_at,
              json_agg(json_build_object('id', s.id, 'spottedAt', s.spotted_at) ORDER BY s.spotted_at DESC) AS sightings,
              a.registration, a.manufacturer, a.model, a.operator
       FROM spottings s
       LEFT JOIN aircraft a ON a.icao24 = s.icao24
       WHERE s.user_id = $1
       GROUP BY s.icao24, a.registration, a.manufacturer, a.model, a.operator
       ORDER BY last_spotted_at DESC`,
      [userId],
    );

    const entries = result.rows.map((r) => ({
      icao24: r.icao24,
      timesSpotted: Number(r.times_spotted),
      firstSpottedAt: r.first_spotted_at,
      lastSpottedAt: r.last_spotted_at,
      sightings: r.sightings,
      registration: r.registration,
      manufacturer: r.manufacturer,
      model: r.model,
      operator: r.operator,
    }));

    return reply.send({
      entries,
      uniqueAircraft: entries.length,
      totalSightings: entries.reduce((sum, e) => sum + e.timesSpotted, 0),
    });
  });

  // Delete a single sighting — e.g. to correct a mis-logged entry. Scoped to
  // the owning user so one account can't delete another's spottings.
  app.delete<{ Params: { id: string } }>("/spottings/:id", async (request, reply) => {
    const userId = await getCurrentUserId(request);
    if (!userId) return reply.code(401).send({ error: "log in to manage your spotting log" });

    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid spotting id" });
    }

    const result = await pool.query("DELETE FROM spottings WHERE id = $1 AND user_id = $2", [
      id,
      userId,
    ]);

    if (result.rowCount === 0) {
      return reply.code(404).send({ error: "spotting not found" });
    }

    return reply.code(204).send();
  });
}
