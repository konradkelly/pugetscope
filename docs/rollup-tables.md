# Rollup tables: `traffic_daily_counts` / `traffic_hourly_counts`

Background on the pre-aggregation pattern used to fix the `/analytics/traffic/*` timeouts — what a rollup table is, why it beats indexing for this particular query shape, and how this project's specific implementation works. Follow-up to [Region-wide-traffic-totals.md](Region-wide-traffic-totals.md) (which added the endpoint that eventually broke) and [postgres-btree-indexing.md](postgres-btree-indexing.md) (the indexing approach that turned out not to be enough).

## The problem indexing couldn't fix

`positions_recorded_at_idx` and `positions_position_gist_idx` (see [postgres-btree-indexing.md](postgres-btree-indexing.md)) are real, correctly-built indexes. They didn't help here because **an index only helps when the predicate is selective** — when it excludes most of the table. `/analytics/traffic/airports` and `/analytics/traffic/volume` filter `recorded_at >= now() - (days || ' days')::interval` with `days` up to 90, but `positions` only held about 10 days of history. At `days=30`, that filter matched **100% of rows** — zero selectivity. No index changes that; Postgres still has to visit every row, and then do it again on every single request.

That's the ceiling indexing runs into: an index makes finding *a subset* of rows cheap. It can't make *aggregating almost all of them* cheap, because the aggregation work (here, `COUNT(DISTINCT icao24 || '-' || date)` — building and sorting a few hundred thousand deduplication keys) still has to happen in full, from scratch, per request. Confirmed live with `EXPLAIN` against prod: cost ~5.29M, Postgres's 30s `statement_timeout` killed it, API returned 500.

## What a rollup table is

Pre-compute the aggregate once, store the small result, and have requests read the small result instead of re-deriving it from the full-size source table every time. "Rolling up" refers to the direction of the aggregation — from fine-grained rows (here, one row per aircraft position ping, arriving every ~30s) up to a coarser grain (one row per airport per calendar day, or per airport per day-and-hour). The general pattern shows up under a few names depending on context — OLAP "roll-up" along a dimension hierarchy (day → month → year), a "summary table," a "pre-aggregation" — but the mechanism is the same: shift aggregation cost from *read time* (expensive, paid by every request) to *write time* (cheap, paid once, amortized across every future read of that period).

This is a different move than indexing. An index still computes the aggregate at read time — it just narrows which rows to visit first. A rollup table skips the read-time aggregation step entirely, at the cost of doing (and maintaining) the aggregation ahead of time.

## This project's implementation

Two tables (`db/init/001_schema.sql:57-71`, duplicated in `k8s/base/postgres-configmap.yaml` per this repo's no-shared-package convention):

```sql
CREATE TABLE IF NOT EXISTS traffic_daily_counts (
  scope TEXT NOT NULL CHECK (scope IN ('KSEA','KPAE','KBFI','KRNT','KTIW','REGION')),
  date DATE NOT NULL,
  flights INTEGER NOT NULL,
  PRIMARY KEY (scope, date)
);

CREATE TABLE IF NOT EXISTS traffic_hourly_counts (
  scope TEXT NOT NULL CHECK (scope IN (...)),
  date DATE NOT NULL,
  hour SMALLINT NOT NULL,
  flights INTEGER NOT NULL,
  PRIMARY KEY (scope, date, hour)
);
```

`scope` is one of the 5 airport ICAO codes or `'REGION'` (the whole coverage area, no spatial filter). Two tables, not one, because they answer genuinely different questions: `traffic_daily_counts.flights` is `COUNT(DISTINCT icao24)` for a whole day; `traffic_hourly_counts.flights` is `COUNT(DISTINCT icao24)` within one (day, hour) bucket. An aircraft seen in two different hours legitimately contributes to both hours' counts but only once to the day's total — so summing the hourly rows for a day can exceed that day's daily-table row. They're not derivable from each other; both have to be maintained.

**Row count stays small on purpose.** `positions` grows by one row per aircraft per ~30s poll — currently ~150k rows/day and unbounded upward. The rollup tables grow by at most 6 scopes × (1 daily + 24 hourly) = 150 rows/day, *regardless of how much traffic there is* — the per-request query cost is now decoupled from `positions`'s size entirely.

### Who writes it, and when

`ingestion/src/db/trafficRollup.ts`'s `refreshTrafficRollup(pool, dates)` re-derives the rollup for a given (contiguous) set of LA calendar dates directly from `positions` — the same kind of `COUNT(DISTINCT icao24)` query the API used to run, just scoped to a couple of days instead of up to 90, and written with `INSERT ... ON CONFLICT (scope, date[, hour]) DO UPDATE SET flights = EXCLUDED.flights` (`trafficRollup.ts:54-89`) so re-running it for a date that already has a row just overwrites it — idempotent, safe to re-run.

Two callers, same function, different date ranges:

- **`ingestion/src/index.ts`'s `pollOnce()`** fires it non-blocking after each poll's `insertPositions` call, recomputing **today + yesterday** every ~30s (`index.ts`, `triggerTrafficRollupRefresh()`). Today+yesterday (not just today) self-heals across the Pacific midnight boundary within one poll cycle. A module-level in-flight guard skips a cycle rather than stacking overlapping refreshes if Postgres is briefly slow — this is a live-traffic service, so a skipped rollup refresh (caught up next cycle) is preferable to holding an extra connection against the same pool `insertPositions` needs.
- **`ingestion/src/backfillTrafficRollup.ts`**, a manual one-time script (`npm run backfill-rollup`, same convention as `enrich`/`load-zips`) that finds `MIN(recorded_at)` and re-derives the rollup for every date from there through today in one call. Needed once per environment, right after this migration ships, to cover whatever `positions` history predates the incremental refresh — see the postmortem below for what happens if you forget this step.

### Why the `WHERE` clause is a plain range, not a function call

`upsertDaily`/`upsertHourly` filter `WHERE p.recorded_at >= $2 AND p.recorded_at < $3` — a plain range on the raw `recorded_at` column, sargable, uses `positions_recorded_at_idx` for a real index range scan. The per-row LA-calendar-day (and hour) bucketing still happens correctly in the `SELECT`/`GROUP BY` via `AT TIME ZONE 'America/Los_Angeles'` — that part *can* wrap the column in a function, because it's not what Postgres needs to use an index for.

The tempting-looking alternative — `WHERE (recorded_at AT TIME ZONE 'America/Los_Angeles')::date = ANY($dates)` — wraps the indexed column itself in a function call in the `WHERE` clause. Postgres can't use a plain B-tree index to satisfy a predicate like that (the index is sorted on raw `recorded_at` values, not on the function's output), so it silently falls back to scanning far more of the table than the date range actually needs — reintroducing, at a smaller scale, the exact selectivity problem this migration exists to kill. `utcRangeForLaDates()` (`trafficRollup.ts:20-41`) sidesteps computing exact DST-aware boundaries by padding 1 hour past the wider of PST/PDT's offset on each side — a few extra edge-case rows get read and then correctly excluded by the `GROUP BY`, never counted wrong, and it avoids hand-rolling timezone-offset arithmetic in JS.

### Reading it back

`api/src/routes/traffic.ts`'s three routes now do a `SUM(flights) ... WHERE scope = $1 AND date BETWEEN $2 AND $3 [GROUP BY ...]` against the rollup tables instead of touching `positions` at all. The `(scope, date[, hour])` primary keys are exactly the prefix these reads filter on, so no extra indexes were needed beyond the PKs. Response shapes are byte-for-byte identical to before (verified against `frontend/src/lib/api.ts`'s types), so this shipped with zero frontend changes.

## The trade-off: a staleness window, and a step that's easy to forget

Nothing is free. A rollup table trades read cost for two things:

1. **Write amplification.** Every poll now does 12 extra small queries (6 scopes × daily + hourly) on top of the position writes it was already doing. Cheap here (each scoped to a 1-2 day range), but it's not zero, and it's proportional to how many scopes/grains you're maintaining.
2. **A staleness/completeness window that has to be actively maintained**, not just assumed. The incremental refresh only touches "today + yesterday" — nothing else ever re-touches a date's rollup. That's fine going forward, but it means the rollup tables start **empty** for any history that predates when the incremental refresh first started running. This bit us: the migration deployed, the incremental refresh started faithfully rolling up today+yesterday, but the one-time backfill for the other 8 days of pre-existing `positions` history didn't get run until it was explicitly noticed — `7d`/`30d`/`90d` all returned identical numbers (because all three windows happened to cover the same 2 actually-rolled-up days) and the day-of-week chart only showed bars for 2 days of the week, until `backfillTrafficRollup.ts` was run by hand against prod.

The general lesson: a rollup table's correctness depends on an invariant — *every date that has source data also has a rollup row for it* — that the schema can't enforce for you. Nothing stops a future change (a replay tool, a manual data import, a fixed ingestion bug that backfills a gap) from inserting historical `positions` rows without also re-running the rollup for those dates. `trafficRollup.ts:109-112` documents this explicitly as a standing invariant for exactly that reason — it's the kind of thing that's obvious while you're building it and easy to forget three months later.

## When this pattern is (and isn't) worth it

Worth it when: the read pattern aggregates over a large, ever-growing fact table, on a small number of predictable dimensions (here: scope × day × hour), and read latency matters more than read freshness being perfectly real-time. The `days=1` "today" number here is accurate within one poll cycle (~30s) of real-time, which is plenty for a traffic dashboard.

Probably not worth it when: the aggregation dimensions aren't known ahead of time (ad-hoc analytics/exploration doesn't fit a fixed rollup shape), the source table is small enough that a direct scan is already fast, or read freshness needs to be exact/immediate (a rollup is inherently *at least* one write-cycle behind the source).
