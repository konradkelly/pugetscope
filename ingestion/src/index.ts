import "dotenv/config";
import { config } from "./config.js";
import { fetchPugetSoundStates, RateLimitedError } from "./openskyClient.js";
import { writeLatestPositions } from "./db/redis.js";
import { insertPositions } from "./db/postgres.js";
import { attachRoutes } from "./enrichment/attachRoutes.js";
import { attachAircraftType } from "./enrichment/attachAircraftType.js";
import { startFidsRefreshWorker } from "./enrichment/fidsRefreshWorker.js";

async function pollOnce(): Promise<void> {
  const states = await fetchPugetSoundStates();
  console.log(`[ingestion] polled ${states.length} aircraft in region`);
  // Attach routes (FIDS board match or own-track inference) before writing
  // to Redis, so the API/WebSocket serve origin/destination. Position
  // history (insertPositions) doesn't need routes, so it uses the raw
  // states and runs in parallel.
  const [routed] = await Promise.all([attachRoutes(states), insertPositions(states)]);
  // Typecode lookup runs after insertPositions (which upserts new icao24
  // rows) rather than in parallel with it, so a first-ever-seen aircraft's
  // own upsert isn't racing this read — not that it matters for typecode
  // (enrich.ts fills that separately), but it keeps the query timing simple.
  const enriched = await attachAircraftType(routed);
  await writeLatestPositions(enriched);
}

async function main(): Promise<void> {
  console.log(
    `[ingestion] starting, polling every ${config.pollIntervalMs}ms`,
  );
  startFidsRefreshWorker();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const start = Date.now();
    try {
      await pollOnce();
    } catch (err) {
      if (err instanceof RateLimitedError) {
        console.warn(`[ingestion] rate limited, backing off ${err.retryAfterSeconds}s`);
        await sleep(err.retryAfterSeconds * 1000);
        continue;
      }
      console.error("[ingestion] poll failed:", err);
    }

    const elapsed = Date.now() - start;
    const remaining = Math.max(config.pollIntervalMs - elapsed, 0);
    await sleep(remaining);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("[ingestion] fatal error:", err);
  process.exit(1);
});
