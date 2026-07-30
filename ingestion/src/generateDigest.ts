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

interface DigestStats {
  date: string;
  totalFlights: number;
  byAirport: Record<string, number>;
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
  return { date, totalFlights: region, byAirport };
}

interface DigestContent {
  headline: string;
  body: string;
  metaDescription: string;
}

async function generateContent(stats: DigestStats): Promise<DigestContent> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

  const airportLines = Object.entries(stats.byAirport)
    .map(([icao, flights]) => `${icao}: ${flights} flights`)
    .join("\n");

  const prompt = `You are writing a short daily traffic digest for PugetScope, a live aircraft tracker for the Puget Sound region (Seattle-Tacoma Intl, Paine Field, Boeing Field, Renton Municipal, Tacoma Narrows).

Yesterday (${stats.date}) traffic, from ADS-B position data:
Region-wide: ${stats.totalFlights} distinct aircraft
${airportLines}

Write:
- headline: a short, specific news-style headline (under 12 words), using the actual numbers.
- body: 2-4 sentences of plain factual prose describing the day's air traffic based only on these numbers. No speculation beyond what the numbers show. No markdown.
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
