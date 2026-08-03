import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({
  connectionString: config.postgres.connectionString,
  ssl: config.postgres.ssl,
  // Explicit rather than relying on pg's default of 10 — this pool only ever
  // does light single-row queries (alerts/cache.ts, alerts/notify.ts), so it
  // doesn't need pg's default budget; keeping it small leaves more of the
  // shared RDS instance's connection budget for api/ingestion.
  max: 5,
});
