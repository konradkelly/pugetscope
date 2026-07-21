import type { FastifyInstance } from "fastify";
import { pool } from "../db/postgres.js";

// Duplicated from ingestion/src/enrichment/regionalAirports.ts rather than
// shared — services are independently deployable with no shared package, and
// this list is small/stable (see docs/SPEC.md §3). Radii match the
// approach-envelope sizing rationale there: KSEA gets a long corridor, small
// GA fields a tight one, so a flight near KBFI/KRNT isn't wrongly pulled into
// SEA's much larger circle only by virtue of `WHERE`-clause ordering (it can
// still legitimately count toward both, since the two circles do overlap).
const REGIONAL_AIRPORTS = [
  { icao: "KSEA", iata: "SEA", name: "Seattle-Tacoma Intl", lat: 47.4502, lon: -122.3088, radiusKm: 25 },
  { icao: "KPAE", iata: "PAE", name: "Paine Field", lat: 47.9063, lon: -122.2816, radiusKm: 15 },
  { icao: "KBFI", iata: "BFI", name: "Boeing Field", lat: 47.53, lon: -122.3019, radiusKm: 12 },
  { icao: "KRNT", iata: "RNT", name: "Renton Municipal", lat: 47.4931, lon: -122.216, radiusKm: 8 },
  { icao: "KTIW", iata: "TIW", name: "Tacoma Narrows", lat: 47.2679, lon: -122.5776, radiusKm: 8 },
] as const;

const MAX_LOOKBACK_DAYS = 90;

function findAirport(icao: string | undefined) {
  return REGIONAL_AIRPORTS.find((a) => a.icao === icao?.toUpperCase());
}

function clampDays(days: string | undefined): number {
  return Math.min(Math.max(Number(days) || 30, 1), MAX_LOOKBACK_DAYS);
}

interface AirportTotalRow {
  icao: string;
  flights: string;
}

interface HourRow {
  hour: number;
  flights: string;
}

interface DayOfWeekRow {
  dow: number;
  flights: string;
}

export async function trafficRoutes(app: FastifyInstance): Promise<void> {
  // Per-airport totals for the lookback window — the "split by airport"
  // comparison (KSEA vs. the 4 regional fields). "Flights" = distinct
  // (icao24, calendar day) pairs within the airport's approach-envelope
  // radius, same proxy the neighborhood-overflight endpoint uses (see
  // analytics.ts) to avoid the ~30s poll cadence inflating the count.
  app.get<{ Querystring: { days?: string } }>(
    "/analytics/traffic/airports",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const lookbackDays = clampDays(request.query.days);

      const result = await pool.query<AirportTotalRow>(
        `SELECT a.icao,
                COUNT(DISTINCT p.icao24 || '-' || to_char(p.recorded_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD')) AS flights
         FROM (VALUES ${REGIONAL_AIRPORTS.map((_, i) => `($${i * 4 + 2}, $${i * 4 + 3}::double precision, $${i * 4 + 4}::double precision, $${i * 4 + 5}::double precision)`).join(", ")})
                 AS a(icao, lon, lat, radius_m)
         LEFT JOIN positions p
           ON ST_DWithin(p.position, ST_MakePoint(a.lon, a.lat)::geography, a.radius_m)
           AND p.recorded_at >= now() - ($1 || ' days')::interval
         GROUP BY a.icao`,
        [
          lookbackDays,
          ...REGIONAL_AIRPORTS.flatMap((a) => [a.icao, a.lon, a.lat, a.radiusKm * 1000]),
        ],
      );

      const byIcao = new Map(result.rows.map((r) => [r.icao, Number(r.flights)]));
      const airports = REGIONAL_AIRPORTS.map((a) => ({
        icao: a.icao,
        iata: a.iata,
        name: a.name,
        flights: byIcao.get(a.icao) ?? 0,
      }));

      return reply.send({ lookbackDays, airports });
    },
  );

  // Hour-of-day and day-of-week breakdown for one airport — "flights/hour"
  // and "day-of-week patterns". Both totaled (not averaged) over the
  // lookback window, matching the neighborhood-overflight endpoint's
  // convention.
  app.get<{ Querystring: { airport?: string; days?: string } }>(
    "/analytics/traffic/volume",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const airport = findAirport(request.query.airport);
      if (!airport) {
        return reply.code(400).send({
          error: `airport must be one of: ${REGIONAL_AIRPORTS.map((a) => a.icao).join(", ")}`,
        });
      }
      const lookbackDays = clampDays(request.query.days);
      const radiusM = airport.radiusKm * 1000;

      const [totalResult, hourlyResult, dowResult] = await Promise.all([
        // Separate from the hourly sum below: a flight spanning multiple
        // hour buckets would otherwise get counted once per bucket.
        pool.query<{ flights: string }>(
          `SELECT COUNT(DISTINCT p.icao24 || '-' || to_char(p.recorded_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD')) AS flights
           FROM positions p
           WHERE ST_DWithin(p.position, ST_MakePoint($1, $2)::geography, $3)
             AND p.recorded_at >= now() - ($4 || ' days')::interval`,
          [airport.lon, airport.lat, radiusM, lookbackDays],
        ),
        pool.query<HourRow>(
          `SELECT
             EXTRACT(HOUR FROM p.recorded_at AT TIME ZONE 'America/Los_Angeles')::int AS hour,
             COUNT(DISTINCT p.icao24 || '-' || to_char(p.recorded_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD')) AS flights
           FROM positions p
           WHERE ST_DWithin(p.position, ST_MakePoint($1, $2)::geography, $3)
             AND p.recorded_at >= now() - ($4 || ' days')::interval
           GROUP BY hour`,
          [airport.lon, airport.lat, radiusM, lookbackDays],
        ),
        pool.query<DayOfWeekRow>(
          `SELECT
             EXTRACT(DOW FROM p.recorded_at AT TIME ZONE 'America/Los_Angeles')::int AS dow,
             COUNT(DISTINCT p.icao24 || '-' || to_char(p.recorded_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD')) AS flights
           FROM positions p
           WHERE ST_DWithin(p.position, ST_MakePoint($1, $2)::geography, $3)
             AND p.recorded_at >= now() - ($4 || ' days')::interval
           GROUP BY dow`,
          [airport.lon, airport.lat, radiusM, lookbackDays],
        ),
      ]);

      const byHour = new Map(hourlyResult.rows.map((r) => [r.hour, Number(r.flights)]));
      const hourly = Array.from({ length: 24 }, (_, hour) => ({
        hour,
        flights: byHour.get(hour) ?? 0,
      }));

      const byDow = new Map(dowResult.rows.map((r) => [r.dow, Number(r.flights)]));
      // Postgres EXTRACT(DOW) is 0=Sunday..6=Saturday.
      const dayOfWeek = Array.from({ length: 7 }, (_, dow) => ({
        dow,
        flights: byDow.get(dow) ?? 0,
      }));

      const totalFlights = Number(totalResult.rows[0]?.flights ?? 0);

      return reply.send({
        airport: airport.icao,
        lookbackDays,
        totalFlights,
        hourly,
        dayOfWeek,
      });
    },
  );
}
