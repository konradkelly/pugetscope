import { Redis } from "ioredis";
import { config } from "../config.js";
import type { StateVector } from "../openskyClient.js";

export const redis = new Redis(config.redisUrl);

export async function writeLatestPositions(states: StateVector[]): Promise<void> {
  if (states.length === 0) return;

  // No separate "active" index: TTL'd keys expire on their own, and the
  // region-wide aircraft count is small enough that the API service can
  // SCAN "aircraft:latest:*" directly rather than maintaining a set that
  // would otherwise need its own stale-member cleanup.
  const pipeline = redis.pipeline();
  for (const s of states) {
    pipeline.set(
      `aircraft:latest:${s.icao24}`,
      JSON.stringify(s),
      "EX",
      config.redisKeyTtlSeconds,
    );
  }
  await pipeline.exec();
}
