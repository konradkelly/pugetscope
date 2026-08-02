import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { pool } from "./db/postgres.js";
import { REGIONAL_AIRPORTS } from "./enrichment/regionalAirports.js";

// One-off nightly script (see package.json's generate-digest) — same
// convention as enrich.ts/loadZips.ts/backfillTrafficRollup.ts. Reads
// yesterday's already-rolled-up traffic_daily_counts (docs/rollup-tables.md)
// rather than positions directly — cheap, proven, no new query shape.
// Mirrors index.ts's todayLA()/yesterdayLA() exactly.
function todayLA(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
}

function yesterdayLA(): string {
  const [y, m, d] = todayLA().split("-").map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d) - 86_400_000);
  return `${yesterday.getUTCFullYear()}-${String(yesterday.getUTCMonth() + 1).padStart(2, "0")}-${String(yesterday.getUTCDate()).padStart(2, "0")}`;
}

interface NotableAircraft {
  icao24: string;
  registration: string | null;
  manufacturer: string | null;
  model: string | null;
  typecode: string | null;
  operator: string | null;
}

interface DigestStats {
  date: string;
  totalFlights: number;
  byAirport: Record<string, number>;
  // §17.1 — same-day-last-week comparison. null when there's no rollup row
  // 7 days back yet (e.g. too early in the project's history), not 0.
  vsLastWeek: number | null;
  // §17.1 — LA-local hour (0-23) with the most distinct aircraft, null if
  // the hourly rollup has no rows for this date.
  busiestHour: number | null;
  // §17.2 — aircraft whose *first-ever* sighting (aircraft.first_seen, which
  // is set once on insert and never updated — see insertPositions's ON
  // CONFLICT) falls on this date. Capped and restricted to rows with a
  // typecode so the digest always has something concrete to describe.
  notableAircraft: NotableAircraft[];
}

const NOTABLE_AIRCRAFT_LIMIT = 5;

async function loadVsLastWeek(date: string): Promise<number | null> {
  const { rows } = await pool.query<{ flights: number }>(
    `SELECT flights FROM traffic_daily_counts
     WHERE scope = 'REGION' AND date = ($1::date - interval '7 days')::date`,
    [date],
  );
  return rows[0] ? Number(rows[0].flights) : null;
}

async function loadBusiestHour(date: string): Promise<number | null> {
  const { rows } = await pool.query<{ hour: number }>(
    `SELECT hour FROM traffic_hourly_counts
     WHERE scope = 'REGION' AND date = $1
     ORDER BY flights DESC
     LIMIT 1`,
    [date],
  );
  return rows[0] ? Number(rows[0].hour) : null;
}

async function loadNotableAircraft(date: string): Promise<NotableAircraft[]> {
  const { rows } = await pool.query<NotableAircraft>(
    `SELECT icao24, registration, manufacturer, model, typecode, operator
     FROM aircraft
     WHERE (first_seen AT TIME ZONE 'America/Los_Angeles')::date = $1::date
       AND typecode IS NOT NULL
     ORDER BY icao24
     LIMIT ${NOTABLE_AIRCRAFT_LIMIT}`,
    [date],
  );
  return rows;
}

async function loadStats(date: string): Promise<DigestStats> {
  const { rows } = await pool.query<{ scope: string; flights: number }>(
    `SELECT scope, flights FROM traffic_daily_counts WHERE date = $1`,
    [date],
  );
  const byScope = new Map(rows.map((r) => [r.scope, Number(r.flights)]));

  // No REGION row means the rollup hasn't run for this date yet — don't
  // publish a wrong "0 flights" digest, fail loudly instead. A present
  // REGION row with flights: 0 is a genuinely quiet day and fine to use.
  const region = byScope.get("REGION");
  if (region === undefined) {
    throw new Error(`no REGION traffic_daily_counts row for ${date} — rollup likely hasn't run yet`);
  }

  const byAirport: Record<string, number> = {};
  for (const airport of REGIONAL_AIRPORTS) {
    byAirport[airport.icao] = byScope.get(airport.icao) ?? 0;
  }

  const [vsLastWeek, busiestHour, notableAircraft] = await Promise.all([
    loadVsLastWeek(date),
    loadBusiestHour(date),
    loadNotableAircraft(date),
  ]);

  return { date, totalFlights: region, byAirport, vsLastWeek, busiestHour, notableAircraft };
}

interface DigestContent {
  headline: string;
  body: string;
  metaDescription: string;
}

// 15 -> "3PM-4PM". Hours are already LA-local (traffic_hourly_counts.hour),
// so this is just formatting, no timezone conversion.
function formatHourRange(hour: number): string {
  const to12h = (h: number) => {
    const period = h < 12 ? "AM" : "PM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}${period}`;
  };
  return `${to12h(hour)}-${to12h((hour + 1) % 24)}`;
}

// null when there's no rollup row from a week ago yet — the digest omits the
// comparison entirely rather than presenting it as a genuinely quiet week.
function formatWeekComparison(stats: DigestStats): string | null {
  if (stats.vsLastWeek === null) return null;
  const delta = stats.totalFlights - stats.vsLastWeek;
  if (delta === 0) return `Same as this day last week (${stats.vsLastWeek} flights).`;
  const direction = delta > 0 ? "Up" : "Down";
  const pct = stats.vsLastWeek > 0 ? Math.round((Math.abs(delta) / stats.vsLastWeek) * 100) : null;
  return `${direction} ${Math.abs(delta)} flights${pct !== null ? ` (${pct}%)` : ""} vs. the same day last week (${stats.vsLastWeek} flights).`;
}

function formatNotableAircraft(list: NotableAircraft[]): string | null {
  if (list.length === 0) return null;
  return list
    .map((a) => {
      const desc = [a.manufacturer, a.model].filter(Boolean).join(" ") || a.typecode;
      const reg = a.registration ? ` (${a.registration})` : "";
      const op = a.operator ? `, operated by ${a.operator}` : "";
      return `${desc}${reg}${op}`;
    })
    .join("; ");
}

async function generateContent(stats: DigestStats): Promise<DigestContent> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

  const airportLines = Object.entries(stats.byAirport)
    .map(([icao, flights]) => `${icao}: ${flights} flights`)
    .join("\n");

  const weekComparisonLine = formatWeekComparison(stats);
  const busiestHourLine =
    stats.busiestHour !== null
      ? `Busiest hour: ${formatHourRange(stats.busiestHour)} (most distinct aircraft observed).`
      : null;
  const notableAircraftLine = formatNotableAircraft(stats.notableAircraft);

  // Extra facts are appended as their own lines only when real data backs
  // them — an absent line means "don't mention this," not "mention it as
  // zero/unknown," matching loadStats()'s existing REGION-row guard.
  const extraFacts = [weekComparisonLine, busiestHourLine, notableAircraftLine ? `First-ever tracked today: ${notableAircraftLine}` : null]
    .filter((line): line is string => line !== null)
    .join("\n");

  const prompt = `You are writing a short daily traffic digest for PugetScope, a live aircraft tracker for the Puget Sound region (Seattle-Tacoma Intl, Paine Field, Boeing Field, Renton Municipal, Tacoma Narrows).

Yesterday (${stats.date}) traffic, from ADS-B position data:
Region-wide: ${stats.totalFlights} distinct aircraft
${airportLines}
${extraFacts ? `\n${extraFacts}` : ""}

Write:
- headline: a short, specific news-style headline (under 12 words), using the actual numbers. Prefer the most striking fact available (a big week-over-week swing or a notable first-time aircraft), but only if one of those lines is present above.
- body: 2-4 sentences of plain factual prose describing the day's air traffic based only on these numbers. No speculation beyond what the numbers show, and never mention a comparison, busiest hour, or aircraft that isn't explicitly listed above. No markdown.
- metaDescription: one sentence (under 160 characters) summarizing the day, suitable for an HTML meta description tag.`;

  // Structured output (JSON schema) rather than tool-use or "ask for JSON" —
  // the API guarantees the first content block is valid JSON matching the
  // schema, so there's no prose-leak parsing to guard against.
  const response = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            headline: { type: "string" },
            body: { type: "string" },
            metaDescription: { type: "string" },
          },
          required: ["headline", "body", "metaDescription"],
          additionalProperties: false,
        },
      },
    },
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("no text block in digest response");
  }
  return JSON.parse(textBlock.text) as DigestContent;
}

async function upsertDigest(stats: DigestStats, content: DigestContent): Promise<void> {
  await pool.query(
    `INSERT INTO digests (date, headline, body, meta_description, stats)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (date) DO UPDATE SET
       headline = EXCLUDED.headline,
       body = EXCLUDED.body,
       meta_description = EXCLUDED.meta_description,
       stats = EXCLUDED.stats`,
    [stats.date, content.headline, content.body, content.metaDescription, JSON.stringify(stats)],
  );
}

async function main(): Promise<void> {
  // Optional, not requireEnv — mirrors fidsRefreshWorker.ts's AERODATABOX_API_KEY
  // gate, adapted for a one-shot script: log and return (exit 0) rather than
  // throwing, so CI/local runs without a key don't fail.
  if (!config.anthropic.apiKey) {
    console.log("[generate-digest] ANTHROPIC_API_KEY not set — skipping");
    return;
  }

  const date = yesterdayLA();
  const stats = await loadStats(date);
  const content = await generateContent(stats);
  await upsertDigest(stats, content);
  console.log(`[generate-digest] wrote digest for ${date}: "${content.headline}"`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[generate-digest] failed:", err);
    process.exit(1);
  });
