import type { FastifyInstance } from "fastify";
import { pool } from "../db/postgres.js";

const ZIP_RE = /^\d{5}$/;
const MAX_LOOKBACK_DAYS = 90;
const MAX_EVENT_WINDOW_HOURS = 24;

async function zipExists(zcta5: string): Promise<boolean> {
  const result = await pool.query("SELECT 1 FROM zip_boundaries WHERE zcta5 = $1", [zcta5]);
  return result.rowCount !== null && result.rowCount > 0;
}

interface SummaryRow {
  hour: number;
  overflights: string; // COUNT(...) comes back as text over the wire
  avg_altitude: string | null;
  min_altitude: string | null;
}

interface EventRow {
  icao24: string;
  callsign: string | null;
  altitude: number | null;
  ground_speed: number | null;
  heading: number | null;
  recorded_at: string;
  registration: string | null;
  manufacturer: string | null;
  model: string | null;
  operator: string | null;
}

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  // Hour-of-day overflight histogram for a zip: how busy is this area, and
  // when. "Overflights" = distinct (aircraft, calendar day) pairs seen in
  // that hour bucket, summed over the lookback window — approximates pass
  // count without being inflated by the ~30s poll cadence producing many
  // rows per actual flyover.
  app.get<{ Querystring: { zip?: string; days?: string } }>(
    "/analytics/overflights/summary",
    // Tighter than the app-wide default (index.ts) — this is a spatial join
    // (ST_Intersects) against the full positions history, not a lookup.
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { zip, days } = request.query;
      if (!zip || !ZIP_RE.test(zip)) {
        return reply.code(400).send({ error: "zip must be a 5-digit ZCTA" });
      }
      if (!(await zipExists(zip))) {
        return reply.code(404).send({ error: "unknown zip (no boundary loaded)" });
      }

      const lookbackDays = Math.min(Math.max(Number(days) || 30, 1), MAX_LOOKBACK_DAYS);

      const result = await pool.query<SummaryRow>(
        `SELECT
           EXTRACT(HOUR FROM p.recorded_at AT TIME ZONE 'America/Los_Angeles')::int AS hour,
           COUNT(DISTINCT p.icao24 || '-' || to_char(p.recorded_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD')) AS overflights,
           AVG(p.altitude) AS avg_altitude,
           MIN(p.altitude) AS min_altitude
         FROM positions p
         JOIN zip_boundaries z ON z.zcta5 = $1
         WHERE ST_Intersects(p.position, z.boundary)
           AND p.recorded_at >= now() - ($2 || ' days')::interval
         GROUP BY hour
         ORDER BY hour`,
        [zip, lookbackDays],
      );

      const byHour = new Map(result.rows.map((r) => [r.hour, r]));
      const hours = Array.from({ length: 24 }, (_, hour) => {
        const row = byHour.get(hour);
        return {
          hour,
          overflights: row ? Number(row.overflights) : 0,
          avgAltitude: row?.avg_altitude != null ? Number(row.avg_altitude) : null,
          minAltitude: row?.min_altitude != null ? Number(row.min_altitude) : null,
        };
      });

      return reply.send({ zip, lookbackDays, hours });
    },
  );

  // What actually flew over this zip in a specific (narrow) time window —
  // the "what was that loud plane at 6:47pm" lookup. One row per aircraft
  // pass, represented by its lowest-altitude point in the window (closest
  // approach), joined against the aircraft reference table.
  app.get<{ Querystring: { zip?: string; from?: string; to?: string } }>(
    "/analytics/overflights/events",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { zip, from, to } = request.query;
      if (!zip || !ZIP_RE.test(zip)) {
        return reply.code(400).send({ error: "zip must be a 5-digit ZCTA" });
      }
      if (!from || !to) {
        return reply.code(400).send({ error: "from and to are required (ISO timestamps)" });
      }
      const fromDate = new Date(from);
      const toDate = new Date(to);
      if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate >= toDate) {
        return reply.code(400).send({ error: "from/to must be valid ISO timestamps with from < to" });
      }
      const windowHours = (toDate.getTime() - fromDate.getTime()) / (60 * 60 * 1000);
      if (windowHours > MAX_EVENT_WINDOW_HOURS) {
        return reply.code(400).send({ error: `window can't exceed ${MAX_EVENT_WINDOW_HOURS}h` });
      }
      if (!(await zipExists(zip))) {
        return reply.code(404).send({ error: "unknown zip (no boundary loaded)" });
      }

      const result = await pool.query<EventRow>(
        `SELECT DISTINCT ON (p.icao24)
           p.icao24, p.callsign, p.altitude, p.ground_speed, p.heading, p.recorded_at,
           a.registration, a.manufacturer, a.model, a.operator
         FROM positions p
         JOIN zip_boundaries z ON z.zcta5 = $1
         LEFT JOIN aircraft a ON a.icao24 = p.icao24
         WHERE ST_Intersects(p.position, z.boundary)
           AND p.recorded_at BETWEEN $2 AND $3
         ORDER BY p.icao24, p.altitude ASC NULLS LAST, p.recorded_at ASC
         LIMIT 200`,
        [zip, fromDate.toISOString(), toDate.toISOString()],
      );

      return reply.send({ zip, from: fromDate.toISOString(), to: toDate.toISOString(), events: result.rows });
    },
  );
}
