# B-tree indexing notes: `positions_recorded_at_idx`

Background on the B-tree index added alongside the region-wide traffic totals endpoint (see [Region-wide-traffic-totals.md](Region-wide-traffic-totals.md)) — what it is, how it's used, and how to decide whether it needs `CONCURRENTLY` when it ships.

## What a B-tree index is

Postgres's default index type. Entries are stored in a sorted tree structure, so looking up a value (or range of values) takes `O(log n)` comparisons instead of scanning every row — the right structure for equality and range predicates (`=`, `<`, `>`, `BETWEEN`), which is what `recorded_at >= now() - interval` needs.

Each entry is `(indexed column value) → pointer to the row's physical location on disk` (a heap TID) — not the row itself, and not a stored aggregate. A query using the index does two steps: use the tree to find the range of matching pointers, then fetch those rows from the table ("heap fetch") to read the rest of their columns. Any counting/grouping (e.g. `COUNT(DISTINCT ...)`) happens fresh at query time over whatever rows the index handed back — nothing is pre-aggregated in the index itself.

## This project's index

```sql
CREATE INDEX IF NOT EXISTS positions_recorded_at_idx ON positions (recorded_at);
```

Single-column, sorted purely by `recorded_at`. Added because the region-wide traffic query (`GET /analytics/traffic/region`) filters only on `recorded_at`, with no `icao24` or spatial predicate to narrow the search.

**Why the existing composite index doesn't cover this**: `positions` already has `positions_icao24_recorded_at_idx (icao24, recorded_at)`. A composite B-tree is sorted lexicographically by its columns in order — like a phone book sorted by last-name-then-first-name. It's sorted by `icao24` first, and only sorted by `recorded_at` *within* each `icao24` group:

- `WHERE icao24 = 'abc123' AND recorded_at >= X` → fast, jumps straight to the `abc123` block.
- `WHERE recorded_at >= X` alone → rows matching are scattered across every `icao24` group throughout the tree, so the index can't narrow anything — Postgres falls back to a sequential scan.

The per-airport routes (`/analytics/traffic/airports`, `/analytics/traffic/volume`) avoid this problem differently: their `ST_DWithin(...)` spatial filter can use the separate GIST index on the `position` column instead.

## `CREATE INDEX` locking behavior

A plain `CREATE INDEX` takes a `SHARE` lock on the table for the whole build:

- Does **not** conflict with `ACCESS SHARE` (plain `SELECT`) — reads are unaffected.
- **Does** conflict with `ROW EXCLUSIVE` (`INSERT`/`UPDATE`/`DELETE`) — writes block and queue until the build finishes, rather than failing.

Build time scales with table size: full scan → sort by the indexed column(s) (using `maintenance_work_mem`, spilling to disk if needed) → write out the tree.

**Why it matters here**: `ingestion/src/index.ts` writes to `positions` continuously (~30s poll cadence). If this index is created against a `positions` table that already has meaningful data, ingestion writes queue up for the build's duration — delayed, not lost, and not user-facing (reads are unaffected), but worth knowing if the ingestion client has an aggressive timeout.

Because the index is guarded by `CREATE INDEX IF NOT EXISTS`, this cost is paid **once** — the first redeploy after this change ships. Every deploy after that is a no-op.

## `CREATE INDEX CONCURRENTLY` — the alternative

Avoids blocking writes by taking a weaker `SHARE UPDATE EXCLUSIVE` lock and doing two scan passes (build from a snapshot, then a second pass to catch concurrent writes, with a wait for in-flight transactions in between).

Trade-offs:

- ~2-3x slower overall (two scans vs. one).
- Cannot run inside a multi-statement transaction block. Not an obstacle here: the schema-init Job runs `psql -f 001_schema.sql` (see [schema-init-job.yaml](../k8s/overlays/ec2/schema-init-job.yaml)) with no `BEGIN`/`COMMIT` wrapping the file, so `psql` already autocommits each statement separately — `CONCURRENTLY` would work as a drop-in swap if needed.
- If interrupted (job killed, connection dropped) partway through, it leaves an `INVALID` index behind instead of rolling back cleanly. A retried `CREATE INDEX CONCURRENTLY IF NOT EXISTS` with the same name sees the name already taken and silently no-ops — it does **not** self-heal. Recovery requires manually `DROP INDEX positions_recorded_at_idx;` before the `IF NOT EXISTS` guard will allow a rebuild.

## Deciding whether to use it

Check the table's actual size before the deploy that will create this index:

```sql
SELECT pg_size_pretty(pg_total_relation_size('positions')) AS total_size,
       n_live_tup AS estimated_rows
FROM pg_stat_user_tables
WHERE relname = 'positions';
```

Use `n_live_tup` rather than `SELECT count(*)` — the latter forces the same kind of full sequential scan this whole exercise is about avoiding.

Rough heuristic (varies with disk speed and `maintenance_work_mem`): low hundreds of MB / low millions of rows → plain `CREATE INDEX` build is sub-second to a few seconds, not worth the added complexity. GB-sized tables / tens of millions of rows → builds can run tens of seconds to minutes, where `CONCURRENTLY` starts being worth it.

To measure directly instead of estimating, time a throwaway index build against a same-sized copy or staging replica:

```sql
\timing on
CREATE INDEX positions_recorded_at_idx_test ON positions (recorded_at);
```

If you skip the pre-check: since this only runs once (gated by `IF NOT EXISTS`), you can just watch that one deploy — `kubectl logs job/schema-init -n pugetscope` and how long `kubectl wait ... job/schema-init` takes — plus check the ingestion service's logs for write timeouts/errors in the following minute or two.
