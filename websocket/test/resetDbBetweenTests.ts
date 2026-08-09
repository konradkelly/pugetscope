import { beforeEach } from "vitest";
import { pool } from "../src/db/postgres.js";
import { redis } from "../src/db/redis.js";

// TRUNCATE ... CASCADE handles FK ordering regardless of the list order
// below — listed in roughly dependency order anyway for readability.
const TABLES = [
  "alert_watches",
  "spottings",
  "positions",
  "push_subscriptions",
  "fids_flights",
  "fids_refresh_state",
  "overflight_hourly_counts",
  "traffic_hourly_counts",
  "traffic_daily_counts",
  "digests",
  "zip_boundaries",
  "user_preferences",
  "aircraft",
  "users",
];

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
  await redis.flushdb();
});
