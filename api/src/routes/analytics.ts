import type { FastifyInstance } from "fastify";
import { pool } from "../db/postgres.js";

const ZIP_RE = /^\d{5}$/;
const MAX_LOOKBACK_DAYS = 90;
const MAX_EVENT_WINDOW_HOURS = 24;

// The 6 curated "noise-relevant" zips the frontend surfaces (see
// NeighborhoodAnalyticsPanel.tsx's ZIP_OPTIONS) — the same list
// ingestion/src/db/overflightRollup.ts maintains overflight_hourly_counts
// for. Duplicated rather than imported per this repo's no-shared-package
// convention (see traffic.ts's REGIONAL_AIRPORTS comment for the same
// rationale). /analytics/overflights/summary reads the rollup, so it's
// restricted to zips the rollup actually covers; /analytics/overflights/events
// stays a live, narrow-window query and keeps accepting any zip loaded into
// zip_boundaries (not just these 6) via zipExists() below.
const NOISE_ZIPS = ["98108", "98146", "98158", "98168", "98188", "98198"];

async function zipExists(zcta5: string): Promise<boolean> {
  const result = await pool.query("SELECT 1 FROM zip_boundaries WHERE zcta5 = $1", [zcta5]);
  return result.rowCount !== null && result.rowCount > 0;
}

// The last `days` calendar dates (YYYY-MM-DD, America/Los_Angeles), ascending,
// ending today. Duplicated from traffic.ts's recentDates() per this repo's
// no-shared-package convention — identical logic, different call site.
function recentDates(days: number): string[] {
  const todayLA = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  const [y, m, d] = todayLA.split("-").map(Number);
  const anchor = Date.UTC(y, m - 1, d);
  return Array.from({ length: days }, (_, i) => {
    const dt = new Date(anchor - (days - 1 - i) * 86_400_000);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  });
}

interface SummaryRow {
  hour: number;
  overflights: string; // COUNT(...) comes back as text over the wire
  altitude_sum: string;
  altitude_count: string;
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
  //
  // Reads overflight_hourly_counts (see db/init/001_schema.sql), maintained
  // incrementally by ingestion (src/db/overflightRollup.ts), rather than
  // ST_Intersects-joining the full `positions` table per request — that used
  // to blow Postgres's statement_timeout once the lookback window covered
  // most of `positions`'s retained history, same failure mode as
  // /analytics/traffic/* before its own rollup fix (see docs/rollup-tables.md).
  // Restricted to NOISE_ZIPS since that's the rollup's scope.
  app.get<{ Querystring: { zip?: string; days?: string } }>(
    "/analytics/overflights/summary",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { zip, days } = request.query;
      if (!zip || !ZIP_RE.test(zip)) {
        return reply.code(400).send({ error: "zip must be a 5-digit ZCTA" });
      }
      if (!NOISE_ZIPS.includes(zip)) {
        return reply.code(404).send({ error: `zip must be one of: ${NOISE_ZIPS.join(", ")}` });
      }

      const lookbackDays = Math.min(Math.max(Number(days) || 30, 1), MAX_LOOKBACK_DAYS);
      const dates = recentDates(lookbackDays);

      const result = await pool.query<SummaryRow>(
        `SELECT
           hour,
           SUM(overflights)::int AS overflights,
           SUM(altitude_sum) AS altitude_sum,
           SUM(altitude_count)::int AS altitude_count,
           MIN(min_altitude) AS min_altitude
         FROM overflight_hourly_counts
         WHERE zcta5 = $1 AND date BETWEEN $2 AND $3
         GROUP BY hour
         ORDER BY hour`,
        [zip, dates[0], dates[dates.length - 1]],
      );

      const byHour = new Map(result.rows.map((r) => [r.hour, r]));
      const hours = Array.from({ length: 24 }, (_, hour) => {
        const row = byHour.get(hour);
        const altitudeCount = Number(row?.altitude_count ?? 0);
        return {
          hour,
          overflights: row ? Number(row.overflights) : 0,
          avgAltitude: row && altitudeCount > 0 ? Number(row.altitude_sum) / altitudeCount : null,
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
