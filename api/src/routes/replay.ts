import type { FastifyInstance } from "fastify";
import { pool } from "../db/postgres.js";

const MAX_WINDOW_SECONDS = 180;
const DEFAULT_WINDOW_SECONDS = 90;

interface BoundsRow {
  earliest: string | null;
  latest: string | null;
}

interface FrameRow {
  icao24: string;
  callsign: string | null;
  lat: number;
  lon: number;
  altitude: number | null;
  ground_speed: number | null;
  heading: number | null;
  vertical_speed: number | null;
  recorded_at: string;
  typecode: string | null;
}

export async function replayRoutes(app: FastifyInstance): Promise<void> {
  // Full available range for the scrubber. MIN/MAX over the B-tree-indexed
  // recorded_at column (positions_recorded_at_idx) is an index-only scan
  // reading one end of the tree each — a different cost profile from the
  // COUNT(DISTINCT ...) that blew statement_timeout in the earlier incident
  // (docs/Region-wide-traffic-totals.md), despite looking similarly "whole
  // table" at a glance.
  app.get("/replay/bounds", async (_request, reply) => {
    const result = await pool.query<BoundsRow>(
      `SELECT MIN(recorded_at) AS earliest, MAX(recorded_at) AS latest FROM positions`,
    );
    const row = result.rows[0];
    return reply.send({ earliest: row?.earliest ?? null, latest: row?.latest ?? null });
  });

  // One row per icao24: its most recent known position within
  // [at - windowSeconds, at]. windowSeconds is capped server-side so the
  // caller can only ever pick *when*, not *how much* — this is what keeps
  // every replay query a narrow, sargable range on the indexed recorded_at
  // column (positions_icao24_recorded_at_idx / positions_recorded_at_idx),
  // never the wide aggregate that caused the earlier timeout incident.
  app.get<{ Querystring: { at?: string; windowSeconds?: string } }>(
    "/replay/frame",
    // Active playback ticks this once/sec (60/min steady-state) plus the
    // frontend debounces manual scrubbing on top of that — 300/min leaves
    // real headroom over that baseline instead of sitting right on the edge
    // (a tight cap here was observed to rate-limit the bulk of requests
    // during ordinary playback, not just abuse).
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { at } = request.query;
      if (!at) {
        return reply.code(400).send({ error: "at is required (ISO timestamp)" });
      }
      const atDate = new Date(at);
      if (Number.isNaN(atDate.getTime())) {
        return reply.code(400).send({ error: "at must be a valid ISO timestamp" });
      }

      const windowSeconds = Math.min(
        Math.max(Number(request.query.windowSeconds) || DEFAULT_WINDOW_SECONDS, 1),
        MAX_WINDOW_SECONDS,
      );
      const fromDate = new Date(atDate.getTime() - windowSeconds * 1000);

      // aircraft.typecode is static reference data (populated by `npm run
      // enrich`), not per-position enrichment — unlike category/route (only
      // ever attached to the live Redis blob), it costs nothing to join here,
      // so a replayed aircraft that's been enriched still gets a real
      // typecode-classified marker instead of always falling back to
      // "unknown" (see frontend's classifyAircraft in aircraftCategory.ts).
      const result = await pool.query<FrameRow>(
        `SELECT DISTINCT ON (p.icao24)
           p.icao24, p.callsign,
           ST_Y(p.position::geometry) AS lat, ST_X(p.position::geometry) AS lon,
           p.altitude, p.ground_speed, p.heading, p.vertical_speed, p.recorded_at,
           a.typecode
         FROM positions p
         LEFT JOIN aircraft a ON a.icao24 = p.icao24
         WHERE p.recorded_at BETWEEN $1 AND $2
         ORDER BY p.icao24, p.recorded_at DESC`,
        [fromDate.toISOString(), atDate.toISOString()],
      );

      const aircraft = result.rows.map((r) => ({
        icao24: r.icao24,
        callsign: r.callsign,
        lat: r.lat,
        lon: r.lon,
        altitude: r.altitude,
        groundSpeed: r.ground_speed,
        headingDeg: r.heading,
        verticalSpeed: r.vertical_speed,
        recordedAt: r.recorded_at,
        typecode: r.typecode,
      }));

      return reply.send({ at: atDate.toISOString(), windowSeconds, aircraft });
    },
  );
}
