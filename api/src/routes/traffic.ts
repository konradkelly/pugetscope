import type { FastifyInstance } from "fastify";
import { pool } from "../db/postgres.js";
import { escapeHtml, getFrontendShell, spliceCrawlerHtml } from "../lib/crawlerPage.js";

// icao/iata/name only — the airport list's lat/lon/radius live in
// ingestion/src/enrichment/regionalAirports.ts, which is what actually
// computes these routes' underlying numbers now (see trafficRollup.ts).
// This file just validates the `airport` param and labels the response.
const REGIONAL_AIRPORTS = [
  { icao: "KSEA", iata: "SEA", name: "Seattle-Tacoma Intl" },
  { icao: "KPAE", iata: "PAE", name: "Paine Field" },
  { icao: "KBFI", iata: "BFI", name: "Boeing Field" },
  { icao: "KRNT", iata: "RNT", name: "Renton Municipal" },
  { icao: "KTIW", iata: "TIW", name: "Tacoma Narrows" },
] as const;

const MAX_LOOKBACK_DAYS = 90;

function findAirport(icao: string | undefined) {
  return REGIONAL_AIRPORTS.find((a) => a.icao === icao?.toUpperCase());
}

function clampDays(days: string | undefined): number {
  return Math.min(Math.max(Number(days) || 30, 1), MAX_LOOKBACK_DAYS);
}

interface HourRow {
  hour: number;
  flights: number;
}

interface DayOfWeekRow {
  dow: number;
  flights: number;
}

interface DailyRow {
  date: string;
  flights: number;
}

// The last `days` calendar dates (YYYY-MM-DD, America/Los_Angeles), ascending,
// ending today — for zero-filling the daily trend. Arithmetic stays in
// UTC-anchored "date-only" space after the initial LA-timezone lookup so
// stepping by day doesn't re-trigger DST conversion.
function recentDates(days: number): string[] {
  const todayLA = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  const [y, m, d] = todayLA.split("-").map(Number);
  const anchor = Date.UTC(y, m - 1, d);
  return Array.from({ length: days }, (_, i) => {
    const dt = new Date(anchor - (days - 1 - i) * 86_400_000);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  });
}

export async function trafficRoutes(app: FastifyInstance): Promise<void> {
  // All 3 routes below read from traffic_daily_counts/traffic_hourly_counts
  // (see db/init/001_schema.sql) rather than scanning `positions` directly.
  // Those rollup tables are maintained incrementally by ingestion
  // (src/db/trafficRollup.ts) — this used to run COUNT(DISTINCT ...) over
  // the full `positions` table per request, which blew Postgres's
  // statement_timeout once the lookback window covered the whole table (see
  // docs/Region-wide-traffic-totals.md for the incident and the rollup
  // design that replaced it).

  app.get<{ Querystring: { days?: string } }>(
    "/analytics/traffic/airports",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const lookbackDays = clampDays(request.query.days);
      const dates = recentDates(lookbackDays);

      const result = await pool.query<{ scope: string; flights: number }>(
        `SELECT scope, SUM(flights)::int AS flights
         FROM traffic_daily_counts
         WHERE scope = ANY($1) AND date BETWEEN $2 AND $3
         GROUP BY scope`,
        [REGIONAL_AIRPORTS.map((a) => a.icao), dates[0], dates[dates.length - 1]],
      );

      // Map, not positional zip: GROUP BY + = ANY() doesn't guarantee row
      // order matches the input list, and a scope with zero matching rows
      // (e.g. no traffic yet) won't appear in the result at all.
      const byScope = new Map(result.rows.map((r) => [r.scope, Number(r.flights)]));
      const airports = REGIONAL_AIRPORTS.map((a) => ({
        icao: a.icao,
        iata: a.iata,
        name: a.name,
        flights: byScope.get(a.icao) ?? 0,
      }));

      return reply.send({ lookbackDays, airports });
    },
  );

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
      const dates = recentDates(lookbackDays);
      const [startDate, endDate] = [dates[0], dates[dates.length - 1]];

      const [totalResult, hourlyResult, dowResult] = await Promise.all([
        pool.query<{ flights: number }>(
          `SELECT SUM(flights)::int AS flights FROM traffic_daily_counts
           WHERE scope = $1 AND date BETWEEN $2 AND $3`,
          [airport.icao, startDate, endDate],
        ),
        pool.query<HourRow>(
          `SELECT hour, SUM(flights)::int AS flights FROM traffic_hourly_counts
           WHERE scope = $1 AND date BETWEEN $2 AND $3
           GROUP BY hour`,
          [airport.icao, startDate, endDate],
        ),
        // Postgres EXTRACT(DOW) is 0=Sunday..6=Saturday.
        pool.query<DayOfWeekRow>(
          `SELECT EXTRACT(DOW FROM date)::int AS dow, SUM(flights)::int AS flights
           FROM traffic_daily_counts
           WHERE scope = $1 AND date BETWEEN $2 AND $3
           GROUP BY dow`,
          [airport.icao, startDate, endDate],
        ),
      ]);

      const byHour = new Map(hourlyResult.rows.map((r) => [r.hour, Number(r.flights)]));
      const hourly = Array.from({ length: 24 }, (_, hour) => ({
        hour,
        flights: byHour.get(hour) ?? 0,
      }));

      const byDow = new Map(dowResult.rows.map((r) => [r.dow, Number(r.flights)]));
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

  app.get<{ Querystring: { days?: string } }>(
    "/analytics/traffic/region",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const lookbackDays = clampDays(request.query.days);
      const dates = recentDates(lookbackDays);
      const [startDate, endDate] = [dates[0], dates[dates.length - 1]];

      const [totalResult, dailyResult, hourlyResult] = await Promise.all([
        pool.query<{ flights: number }>(
          `SELECT SUM(flights)::int AS flights FROM traffic_daily_counts
           WHERE scope = 'REGION' AND date BETWEEN $1 AND $2`,
          [startDate, endDate],
        ),
        pool.query<DailyRow>(
          `SELECT to_char(date, 'YYYY-MM-DD') AS date, flights
           FROM traffic_daily_counts
           WHERE scope = 'REGION' AND date BETWEEN $1 AND $2`,
          [startDate, endDate],
        ),
        pool.query<HourRow>(
          `SELECT hour, SUM(flights)::int AS flights FROM traffic_hourly_counts
           WHERE scope = 'REGION' AND date BETWEEN $1 AND $2
           GROUP BY hour`,
          [startDate, endDate],
        ),
      ]);

      const byDate = new Map(dailyResult.rows.map((r) => [r.date, Number(r.flights)]));
      const daily = dates.map((date) => ({
        date,
        flights: byDate.get(date) ?? 0,
      }));

      const byHour = new Map(hourlyResult.rows.map((r) => [r.hour, Number(r.flights)]));
      const hourly = Array.from({ length: 24 }, (_, hour) => ({
        hour,
        flights: byHour.get(hour) ?? 0,
      }));

      const totalFlights = Number(totalResult.rows[0]?.flights ?? 0);

      return reply.send({
        lookbackDays,
        totalFlights,
        daily,
        hourly,
      });
    },
  );

  // Crawler/browser-facing page — reached at the bare pugetscope.com/traffic
  // (no /api prefix, see k8s/base/ingress.yaml), a real server-rendered HTML
  // document so the page has indexable text with no JS execution required.
  // Same pattern as digest.ts's /digest and airports.ts's /airport/:icao; a
  // hub page that links out to every /airport/:icao page, which also helps
  // Google understand the site's overall structure. The SPA's own
  // client-side route (useUrlRoute.ts's "trafficOverview") opens the
  // traffic panel defaulted to the same region-wide view once hydrated.
  app.get("/traffic", async (request, reply) => {
    let shell: string;
    try {
      shell = await getFrontendShell();
    } catch (err) {
      request.log.error(err, "[traffic] frontend shell unavailable");
      return reply.code(503).send("Page temporarily unavailable.");
    }

    const dates = recentDates(7);
    const [regionResult, airportResult] = await Promise.all([
      pool.query<{ flights: number }>(
        `SELECT SUM(flights)::int AS flights FROM traffic_daily_counts
         WHERE scope = 'REGION' AND date BETWEEN $1 AND $2`,
        [dates[0], dates[dates.length - 1]],
      ),
      pool.query<{ scope: string; flights: number }>(
        `SELECT scope, SUM(flights)::int AS flights
         FROM traffic_daily_counts
         WHERE scope = ANY($1) AND date BETWEEN $2 AND $3
         GROUP BY scope`,
        [REGIONAL_AIRPORTS.map((a) => a.icao), dates[0], dates[dates.length - 1]],
      ),
    ]);

    const regionFlights = Number(regionResult.rows[0]?.flights ?? 0);
    const byScope = new Map(airportResult.rows.map((r) => [r.scope, Number(r.flights)]));
    const airports = REGIONAL_AIRPORTS.map((a) => ({
      ...a,
      flights: byScope.get(a.icao) ?? 0,
    })).sort((a, b) => b.flights - a.flights);

    const title = "Puget Sound Air Traffic Overview | PugetScope";
    const description = `Region-wide flight volume across Sea-Tac, Paine Field, Boeing Field, Renton, and Tacoma Narrows, tracked live by PugetScope. ${regionFlights.toLocaleString()} distinct aircraft over the region in the past 7 days.`;
    // Per-field counts aren't a breakdown of regionFlights and won't sum to
    // it — a single aircraft can register near more than one nearby field,
    // while the region total counts each distinct aircraft once (same
    // scope='REGION' vs per-airport semantics /analytics/traffic/region and
    // /analytics/traffic/airports already have). Worded as two separate
    // facts, not "here's the breakdown", so that isn't read as a contradiction.
    const items = airports
      .map(
        (a) =>
          `<li><a href="/airport/${a.icao}">${escapeHtml(a.name)} (${a.icao})</a> — ${a.flights.toLocaleString()} flights tracked nearby</li>`,
      )
      .join("");
    const bodyHtml = `<article><h1>Puget Sound Air Traffic Overview</h1><p>PugetScope tracked ${regionFlights.toLocaleString()} distinct aircraft over the Puget Sound region in the past 7 days. Here's the 7-day flight count at each of the region's fields:</p><ul>${items}</ul><p><a href="/">View the live tracker &rarr;</a></p></article>`;

    const url = `${request.protocol}://${request.headers.host}/traffic`;
    const html = spliceCrawlerHtml(shell, { title, description, url, bodyHtml });

    return reply.type("text/html").send(html);
  });
}
