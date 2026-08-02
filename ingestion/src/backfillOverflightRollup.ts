import "dotenv/config";
import { pool } from "./db/postgres.js";
import { refreshOverflightRollup } from "./db/overflightRollup.js";

// One-time manual script (see ingestion/package.json's `backfill-overflight-
// rollup`) — same convention as backfillTrafficRollup.ts, with one real
// difference: this backfills one LA date at a time rather than the whole
// range in a single refreshOverflightRollup call. Unlike traffic's
// ST_DWithin-from-a-point spatial filter, this query's ST_Intersects JOIN
// against zip_boundaries is pricier per row, and since `positions` only
// retains a couple weeks of history, a "backfill everything" range isn't a
// selective predicate — it's most of the table. Verified live: a single
// call covering all 17 days present in production timed out at 120s: exactly
// the same non-selective-predicate failure mode docs/rollup-tables.md
// documents, just hitting the one-time backfill instead of a live request.
// Chunking to one day per call bounds each query to ~a day's worth of
// `positions` regardless of how much history exists.
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
    console.log("[backfill-overflight-rollup] positions table is empty, nothing to backfill");
    return;
  }

  const dates = allLaDatesBetween(minDate, todayLA);
  console.log(`[backfill-overflight-rollup] backfilling ${dates.length} date(s): ${minDate} through ${todayLA}`);
  // Generous per-day timeout vs. the poll loop's 5s default — same rationale
  // as backfillTrafficRollup.ts's BACKFILL_STATEMENT_TIMEOUT_MS, just applied
  // per date instead of once for the whole range (see comment above).
  const BACKFILL_STATEMENT_TIMEOUT_MS = 30_000;
  for (const date of dates) {
    await refreshOverflightRollup(pool, [date], BACKFILL_STATEMENT_TIMEOUT_MS);
    console.log(`[backfill-overflight-rollup] ${date} done`);
  }
  console.log("[backfill-overflight-rollup] done");
}

backfill()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-overflight-rollup] failed:", err);
    process.exit(1);
  });
