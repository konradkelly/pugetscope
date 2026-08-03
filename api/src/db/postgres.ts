import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({
  connectionString: config.postgres.connectionString,
  ssl: config.postgres.ssl,
  // Safety net so a heavy analytics query (e.g. traffic/airports at a large
  // `days` window) fails fast with a 500 instead of running indefinitely and
  // tying up a pool connection until the ingress's own timeout cuts it off.
  statement_timeout: 30_000,
  // Explicit rather than relying on pg's default of 10 — this pool is one of
  // three services (api/ingestion/websocket) sharing the same small RDS
  // instance, so each service's connection budget should be a deliberate,
  // documented number rather than an accidental default.
  max: 10,
});

// Without this, a network error on an idle client (e.g. RDS dropping a
// connection) is an unhandled 'error' event and crashes the process.
pool.on("error", (err) => {
  console.error("[postgres] idle client error:", err);
});
