import "dotenv/config";
import { pool } from "./db/postgres.js";
import { refreshTrafficRollup } from "./db/trafficRollup.js";

// One-time manual script (see ingestion/package.json's `backfill-rollup`) —
// same convention as enrich.ts/loadZips.ts. Populates traffic_daily_counts/
// traffic_hourly_counts for all of `positions`'s existing history in one
// shot: refreshTrafficRollup's WHERE clause is a sargable range on
// recorded_at, so this stays cheap regardless of how far back history goes
// (no day-by-day chunking needed for correctness — see
// docs/Region-wide-traffic-totals.md for why the *old* per-request queries
// couldn't say the same).
function allLaDatesBetween(minDate: string, maxDate: string): string[] {
  const [y, m, d] = minDate.split("-").map(Number);
  const anchor = Date.UTC(y, m - 1, d);
  const [ey, em, ed] = maxDate.split("-").map(Number);
  const endAnchor = Date.UTC(ey, em - 1, ed);

  const dates: string[] = [];
  for (let t = anchor; t <= endAnchor; t += 86_400_000) {
    const dt = new Date(t);
    dates.push(
      `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`,
    );
  }
  return dates;
}

async function backfill(): Promise<void> {
  const todayLA = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());

  const { rows } = await pool.query<{ min_date: string | null }>(
    `SELECT to_char(MIN(recorded_at) AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD') AS min_date FROM positions`,
  );
  const minDate = rows[0]?.min_date;
  if (!minDate) {
    console.log("[backfill-rollup] positions table is empty, nothing to backfill");
    return;
  }

  const dates = allLaDatesBetween(minDate, todayLA);
  console.log(`[backfill-rollup] backfilling ${dates.length} date(s): ${minDate} through ${todayLA}`);
  // Generous timeout vs. the poll loop's 5s default: this is a one-time,
  // manually-run, watched operation covering a much wider date range than
  // the incremental "today + yesterday" case, so each query needs more room.
  const BACKFILL_STATEMENT_TIMEOUT_MS = 120_000;
  await refreshTrafficRollup(pool, dates, BACKFILL_STATEMENT_TIMEOUT_MS);
  console.log("[backfill-rollup] done");
}

backfill()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-rollup] failed:", err);
    process.exit(1);
  });
