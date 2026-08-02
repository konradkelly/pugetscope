import type { FastifyInstance } from "fastify";
import { pool } from "../db/postgres.js";
import { redis } from "../db/redis.js";
import { escapeHtml, getFrontendShell, spliceCrawlerHtml } from "../lib/crawlerPage.js";

// icao/iata/name only, same convention (and same 5 fields) as traffic.ts —
// this repo's no-shared-package convention (docs/rollup-tables.md) means
// each route file that needs to validate/label a regional airport keeps its
// own small copy rather than importing from `ingestion`.
const REGIONAL_AIRPORTS = [
  { icao: "KSEA", iata: "SEA", name: "Seattle-Tacoma Intl" },
  { icao: "KPAE", iata: "PAE", name: "Paine Field" },
  { icao: "KBFI", iata: "BFI", name: "Boeing Field" },
  { icao: "KRNT", iata: "RNT", name: "Renton Municipal" },
  { icao: "KTIW", iata: "TIW", name: "Tacoma Narrows" },
] as const;

function findAirport(icao: string | undefined) {
  return REGIONAL_AIRPORTS.find((a) => a.icao === icao?.toUpperCase());
}

interface BoardRow {
  direction: "departure" | "arrival";
  call_sign: string;
  flight_number: string | null;
  status: string | null;
  airline_name: string | null;
  other_icao: string | null;
  other_iata: string | null;
  other_name: string | null;
  scheduled_time: string | null;
  revised_time: string | null;
}

function toBoardEntry(row: BoardRow) {
  return {
    callSign: row.call_sign,
    flightNumber: row.flight_number,
    airlineName: row.airline_name,
    status: row.status,
    other: { icao: row.other_icao, iata: row.other_iata, name: row.other_name },
    scheduledTime: row.scheduled_time,
    revisedTime: row.revised_time,
  };
}

export async function airportsRoutes(app: FastifyInstance): Promise<void> {
  // Live departures/arrivals board per regional field — the same
  // fids_flights data attachRoutes.ts already joins against per-aircraft
  // (§12), surfaced here as its own view. fids_flights is kept board-shaped
  // by ingestion's replaceBoard() (full DELETE + re-INSERT per refresh), so
  // no extra staleness filtering is needed here beyond an ORDER BY.
  app.get<{ Params: { icao: string }; Querystring: { direction?: string } }>(
    "/airports/:icao/board",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const airport = findAirport(request.params.icao);
      if (!airport) {
        return reply.code(400).send({
          error: `icao must be one of: ${REGIONAL_AIRPORTS.map((a) => a.icao).join(", ")}`,
        });
      }

      const { direction } = request.query;
      if (direction !== undefined && direction !== "departure" && direction !== "arrival") {
        return reply.code(400).send({ error: 'direction must be "departure" or "arrival"' });
      }

      const result = await pool.query<BoardRow>(
        `SELECT direction, call_sign, flight_number, status, airline_name,
                other_icao, other_iata, other_name, scheduled_time, revised_time
         FROM fids_flights
         WHERE airport_icao = $1 AND ($2::text IS NULL OR direction = $2)
         ORDER BY COALESCE(revised_time, scheduled_time) ASC`,
        [airport.icao, direction ?? null],
      );

      const departures = result.rows.filter((r) => r.direction === "departure").map(toBoardEntry);
      const arrivals = result.rows.filter((r) => r.direction === "arrival").map(toBoardEntry);

      return reply.send({ airport: airport.icao, departures, arrivals });
    },
  );

  // Which runway/flow direction a regional field is currently using,
  // inferred purely from observed approach geometry — see docs/SPEC.md §15
  // and ingestion/src/enrichment/flowDirection.ts. Reads airport:flow:{icao}
  // straight from Redis (mirrors aircraft.ts's /aircraft reading
  // aircraft:latest:*) — deliberately not pushed through the WebSocket
  // /live feed, since this changes on the order of hours, not seconds.
  app.get<{ Params: { icao: string } }>("/airports/:icao/flow", async (request, reply) => {
    const airport = findAirport(request.params.icao);
    if (!airport) {
      return reply.code(400).send({
        error: `icao must be one of: ${REGIONAL_AIRPORTS.map((a) => a.icao).join(", ")}`,
      });
    }

    const raw = await redis.get(`airport:flow:${airport.icao}`);
    // No key yet (ingestion hasn't run, or the TTL lapsed) is a normal,
    // graceful-degradation state here, not an error — same posture as the
    // board route returning empty arrays when FIDS isn't configured.
    const reading = raw
      ? JSON.parse(raw)
      : { runway: null, flow: null, headingDeg: null, confidence: "unknown", sampleSize: 0, asOf: null };

    return reply.send({ airport: airport.icao, ...reading });
  });

  // Crawler/browser-facing page — reached at the bare pugetscope.com/airport/:icao
  // (no /api prefix, see k8s/base/ingress.yaml), a real server-rendered HTML
  // document so the page has indexable text with no JS execution required.
  // Same pattern as digest.ts's /digest/:date; the SPA's own client-side
  // route (useUrlRoute.ts) opens the same board on this URL once hydrated.
  app.get<{ Params: { icao: string } }>("/airport/:icao", async (request, reply) => {
    const airport = findAirport(request.params.icao);
    if (!airport) {
      return reply.code(404).send("Unknown airport.");
    }

    let shell: string;
    try {
      shell = await getFrontendShell();
    } catch (err) {
      request.log.error(err, "[airports] frontend shell unavailable");
      return reply.code(503).send("Page temporarily unavailable.");
    }

    // 7-day total, same rollup traffic.ts's /analytics/traffic/volume reads —
    // cheap enough to run per-request (indexed sum over a handful of rows)
    // and gives crawlers/link-preview a real, current number rather than
    // static boilerplate.
    const dates = recentDates(7);
    const totalResult = await pool.query<{ flights: number }>(
      `SELECT SUM(flights)::int AS flights FROM traffic_daily_counts
       WHERE scope = $1 AND date BETWEEN $2 AND $3`,
      [airport.icao, dates[0], dates[dates.length - 1]],
    );
    const weekFlights = Number(totalResult.rows[0]?.flights ?? 0);

    const title = `${airport.name} (${airport.icao}) Live Departures & Arrivals | PugetScope`;
    const description = `Live departure and arrival board for ${airport.name} (${airport.icao}), part of PugetScope's real-time Puget Sound aircraft tracker. ${weekFlights.toLocaleString()} flights tracked in the past 7 days.`;
    const bodyHtml = `<article><h1>${escapeHtml(airport.name)} (${escapeHtml(airport.icao)}) — Live Departures &amp; Arrivals</h1><p>PugetScope tracked ${weekFlights.toLocaleString()} flights at ${escapeHtml(airport.name)} over the past 7 days.</p><p>See the live departure and arrival board, current runway flow, and per-flight tracking on the map.</p><p><a href="/">View the live tracker &rarr;</a></p></article>`;

    const url = `${request.protocol}://${request.headers.host}/airport/${airport.icao}`;
    const html = spliceCrawlerHtml(shell, { title, description, url, bodyHtml });

    return reply.type("text/html").send(html);
  });
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
