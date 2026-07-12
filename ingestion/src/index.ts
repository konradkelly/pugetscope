import "dotenv/config";
import { config } from "./config.js";
import { fetchPugetSoundStates, RateLimitedError } from "./openskyClient.js";
import { writeLatestPositions } from "./db/redis.js";
import { insertPositions } from "./db/postgres.js";

async function pollOnce(): Promise<void> {
  const states = await fetchPugetSoundStates();
  console.log(`[ingestion] polled ${states.length} aircraft in region`);
  await Promise.all([writeLatestPositions(states), insertPositions(states)]);
}

async function main(): Promise<void> {
  console.log(
    `[ingestion] starting, polling every ${config.pollIntervalMs}ms`,
  );

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
