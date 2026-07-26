import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({
  connectionString: config.postgres.connectionString,
  ssl: config.postgres.ssl,
  // Safety net so a heavy analytics query (e.g. traffic/airports at a large
  // `days` window) fails fast with a 500 instead of running indefinitely and
  // tying up a pool connection until the ingress's own timeout cuts it off.
  statement_timeout: 30_000,
});
