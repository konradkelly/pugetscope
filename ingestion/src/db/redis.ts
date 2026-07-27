import { Redis } from "ioredis";
import { config } from "../config.js";
import type { EnrichedStateVector } from "../enrichment/attachRoutes.js";
import type { FlowReading } from "../enrichment/flowDirection.js";

export const redis = new Redis(config.redisUrl);

// Short TTL so a stale reading self-clears if ingestion stops, rather than
// the api serving a confident-looking flow direction from hours ago — see
// docs/SPEC.md §15.
const FLOW_KEY_TTL_SECONDS = 10 * 60;

export async function writeLatestPositions(states: EnrichedStateVector[]): Promise<void> {
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

  // Notifies the websocket service that a new batch is available — see
  // websocket/src/redisSubscriber.ts. Pub/sub is fire-and-forget (no
  // history, no delivery guarantee), which is fine here: it's just a
  // "go re-read the latest state" signal, and the state itself already
  // lives durably in the keys just written above.
  await redis.publish("aircraft:updates", JSON.stringify(states));
}

// One key per regional field, read directly by api's GET /airports/:icao/flow
// (mirrors aircraft:latest:* / GET /aircraft) — deliberately not pushed
// through the WebSocket feed, since flow direction changes on the order of
// hours, not seconds. See docs/SPEC.md §15.
export async function writeFlowReadings(readings: Map<string, FlowReading>): Promise<void> {
  if (readings.size === 0) return;

  const pipeline = redis.pipeline();
  for (const [icao, reading] of readings) {
    pipeline.set(`airport:flow:${icao}`, JSON.stringify(reading), "EX", FLOW_KEY_TTL_SECONDS);
  }
  await pipeline.exec();
}
