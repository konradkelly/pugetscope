import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { pool } from "./db/postgres.js";
import { buildPrompt, yesterdayLA, type DigestContent, type DigestStats } from "./digest/format.js";
import { loadStats } from "./digest/loadStats.js";
import { sendDigestEmails } from "./email/sendDigestEmails.js";

// One-off nightly script (see package.json's generate-digest) — same
// convention as enrich.ts/loadZips.ts/backfillTrafficRollup.ts. Stat loading
// lives in digest/loadStats.ts and prompt assembly in digest/format.ts; what's
// left here is the Anthropic call, the upsert, and the wiring between them.

async function generateContent(stats: DigestStats): Promise<DigestContent> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

  // Structured output (JSON schema) rather than tool-use or "ask for JSON" —
  // the API guarantees the first content block is valid JSON matching the
  // schema, so there's no prose-leak parsing to guard against.
  const response = await client.messages.create({
    model: "claude-sonnet-5",
    // 1024 was enough back when thinking was opt-in; Sonnet 5 thinks by
    // default now, and a busy day's stats could burn the whole budget on
    // thinking tokens before ever reaching the JSON text block (the
    // "no text block in digest response" failure). effort: "low" keeps
    // thinking short for this simple summarization task — plenty of
    // headroom left, not just a bigger cap papering over the real cost.
    max_tokens: 4096,
    output_config: {
      effort: "low",
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
    messages: [{ role: "user", content: buildPrompt(stats) }],
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
  const stats = await loadStats(pool, date);
  const content = await generateContent(stats);
  await upsertDigest(stats, content);
  console.log(`[generate-digest] wrote digest for ${date}: "${content.headline}"`);

  await sendDigestEmails(pool, date, content.headline, content.body);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[generate-digest] failed:", err);
    process.exit(1);
  });
