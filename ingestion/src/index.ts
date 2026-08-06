import "dotenv/config";
import { config } from "./config.js";
import { fetchPugetSoundStates, RateLimitedError } from "./openskyClient.js";
import { writeLatestPositions, writeFlowReadings } from "./db/redis.js";
import { insertPositions, pool, rollupPool } from "./db/postgres.js";
import { refreshTrafficRollup } from "./db/trafficRollup.js";
import { refreshOverflightRollup } from "./db/overflightRollup.js";
import { attachRoutes } from "./enrichment/attachRoutes.js";
import { attachAircraftType } from "./enrichment/attachAircraftType.js";
import { startFidsRefreshWorker } from "./enrichment/fidsRefreshWorker.js";
import { recordFlowObservations, computeFlowReadings } from "./enrichment/flowDirection.js";
import {
  startMetricsServer,
  pollDuration,
  pollTotal,
  aircraftInRegion,
  rollupRefreshDuration,
  rollupRefreshSkipped,
} from "./metrics.js";

// Same UTC-anchored LA-date approach as api/src/routes/traffic.ts's
// recentDates() (not shared — see that file's REGIONAL_AIRPORTS comment on
// the project's per-service duplication convention).
function todayLA(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
}

function yesterdayLA(): string {
  const [y, m, d] = todayLA().split("-").map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d) - 86_400_000);
  return `${yesterday.getUTCFullYear()}-${String(yesterday.getUTCMonth() + 1).padStart(2, "0")}-${String(yesterday.getUTCDate()).padStart(2, "0")}`;
}

// Guards against overlapping refreshes stacking up connection usage across
// refresh cycles if Postgres is briefly slow — a skipped cycle just catches
// up on the next one, since refreshTrafficRollup always redoes today+yesterday.
let rollupRefreshInFlight = false;

function triggerTrafficRollupRefresh(): void {
  if (rollupRefreshInFlight) {
    rollupRefreshSkipped.labels("traffic").inc();
    console.warn("[ingestion] skipping rollup refresh — previous cycle still in flight");
    return;
  }
  rollupRefreshInFlight = true;
  const start = Date.now();
  refreshTrafficRollup(rollupPool, [todayLA(), yesterdayLA()])
    .catch((err) => console.error("[ingestion] rollup refresh failed:", err))
    .finally(() => {
      rollupRefreshInFlight = false;
      rollupRefreshDuration.labels("traffic").observe((Date.now() - start) / 1000);
    });
}

// Same guard-per-refresh-type pattern as triggerTrafficRollupRefresh — a
// separate flag so a slow overflight refresh can't also skip/delay the
// traffic one (or vice versa).
let overflightRollupRefreshInFlight = false;

function triggerOverflightRollupRefresh(): void {
  if (overflightRollupRefreshInFlight) {
    rollupRefreshSkipped.labels("overflight").inc();
    console.warn("[ingestion] skipping overflight rollup refresh — previous cycle still in flight");
    return;
  }
  overflightRollupRefreshInFlight = true;
  const start = Date.now();
  refreshOverflightRollup(rollupPool, [todayLA(), yesterdayLA()])
    .catch((err) => console.error("[ingestion] overflight rollup refresh failed:", err))
    .finally(() => {
      overflightRollupRefreshInFlight = false;
      rollupRefreshDuration.labels("overflight").observe((Date.now() - start) / 1000);
    });
}

// Decouples rollup recompute cadence from the 30s poll loop (see
// config.rollupRefreshIntervalMs) — both rollups redo their whole
// today+yesterday window every time they run, so firing them on every poll
// tick was 10x more spatial-join load than the hourly buckets need.
let lastRollupRefreshAt = 0;

function maybeTriggerRollupRefreshes(): void {
  const now = Date.now();
  if (now - lastRollupRefreshAt < config.rollupRefreshIntervalMs) return;
  lastRollupRefreshAt = now;
  triggerTrafficRollupRefresh();
  triggerOverflightRollupRefresh();
}

async function pollOnce(): Promise<void> {
  const states = await fetchPugetSoundStates();
  console.log(`[ingestion] polled ${states.length} aircraft in region`);
  aircraftInRegion.set(states.length);
  // Attach routes (FIDS board match or own-track inference) before writing
  // to Redis, so the API/WebSocket serve origin/destination. Position
  // history (insertPositions) doesn't need routes, so it uses the raw
  // states and runs in parallel.
  const [routed] = await Promise.all([attachRoutes(states), insertPositions(states)]);
  // Fire-and-forget, and only once per rollupRefreshIntervalMs (not every
  // poll): refreshes traffic_daily_counts/traffic_hourly_counts and
  // overflight_hourly_counts from freshly-written positions. Never awaited —
  // a slow/failed rollup query must not delay the live position/Redis write
  // path below.
  maybeTriggerRollupRefreshes();
  // Typecode lookup runs after insertPositions (which upserts new icao24
  // rows) rather than in parallel with it, so a first-ever-seen aircraft's
  // own upsert isn't racing this read — not that it matters for typecode
  // (enrich.ts fills that separately), but it keeps the query timing simple.
  const enriched = await attachAircraftType(routed);
  // Flow-direction inference (docs/SPEC.md §15): a pure in-memory rolling
  // vote over the raw (unrouted) states, so it doesn't need to wait on
  // anything above. Cheap enough to run in-line rather than fire-and-forget.
  recordFlowObservations(states);
  const flowReadings = computeFlowReadings();
  await Promise.all([writeLatestPositions(enriched), writeFlowReadings(flowReadings)]);
}

async function main(): Promise<void> {
  console.log(
    `[ingestion] starting, polling every ${config.pollIntervalMs}ms`,
  );
  startMetricsServer(config.metricsPort);
  startFidsRefreshWorker();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const start = Date.now();
    try {
      await pollOnce();
      pollTotal.labels("success").inc();
    } catch (err) {
      if (err instanceof RateLimitedError) {
        pollTotal.labels("rate_limited").inc();
        pollDuration.observe((Date.now() - start) / 1000);
        console.warn(`[ingestion] rate limited, backing off ${err.retryAfterSeconds}s`);
        await sleep(err.retryAfterSeconds * 1000);
        continue;
      }
      pollTotal.labels("error").inc();
      console.error("[ingestion] poll failed:", err);
    }
    pollDuration.observe((Date.now() - start) / 1000);

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
