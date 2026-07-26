Region-wide traffic totals (backend)
Context
TrafficVolumePanel currently only shows per-airport traffic, computed via ST_DWithin against each of the 5 regional airport circles in api/src/routes/traffic.ts. Those circles overlap (e.g. KSEA's 25km radius overlaps KBFI/KRNT), so summing the per-airport numbers double-counts aircraft near multiple fields — it can't be reused to produce a true region-wide total.

The user wants a total of all flights detected per calendar day (trend over the lookback window) and per hour-of-day, across the whole Puget Sound coverage area — not per airport. Ingestion (ingestion/src/config.ts:20-23) already scopes every row in positions to a single Puget Sound bounding box, so — unlike the per-airport case — a region-wide total needs no spatial filter at all: it's just every row in positions within the time window, deduped the same way the existing endpoints dedupe (distinct icao24 + calendar day, to avoid the ~30s poll cadence inflating counts).

This plan covers the new backend endpoint only (per the user's ask); wiring it into TrafficVolumePanel is a follow-up.

Approach
Add a third route to api/src/routes/traffic.ts: GET /analytics/traffic/region?days=.

Reuses clampDays() (traffic.ts:25-27) and the existing 1..MAX_LOOKBACK_DAYS(90) convention — same as the other two routes.

Response shape:

{
  lookbackDays: number,
  totalFlights: number,
  daily: { date: string; flights: number }[],   // one entry per calendar day in the window, Pacific time, zero-filled
  hourly: { hour: number; flights: number }[],   // 24 entries, same shape as the existing per-airport hourly array
}
Three queries run in parallel via Promise.all (mirrors the existing /volume route at traffic.ts:100-130), all filtered only by recorded_at >= now() - ($1 || ' days')::interval — no ST_DWithin/geography join:

Total: COUNT(DISTINCT icao24 || '-' || to_char(recorded_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD')) over all of positions in the window.
Daily trend: GROUP BY to_char(recorded_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD'), with COUNT(DISTINCT icao24) per group (the day is already fixed by the grouping, so no need to concat it into the dedup key like the total/hourly queries do). In JS, zero-fill every calendar date between today - lookbackDays + 1 and today (Pacific) so gaps render as 0 rather than being omitted — there's no existing helper for this since the current hourly/day-of-week arrays are fixed-length (Array.from({length: 24 or 7})); this needs a small date-range generator.
Hourly: same GROUP BY EXTRACT(HOUR ...) + dedup-by-icao24+day pattern as the existing per-airport hourly query (traffic.ts:110-119), just without the spatial WHERE.
Same rate-limit config as the other two routes: { rateLimit: { max: 20, timeWindow: "1 minute" } }.

Performance note (worth deciding now)
The existing composite index positions_icao24_recorded_at_idx (icao24, recorded_at) (db/init/001_schema.sql:41-42) doesn't help a query that filters on recorded_at alone with no icao24 predicate — this new endpoint would sequential-scan the full window's worth of rows on every call. The per-airport routes avoid this because ST_DWithin can use the GIST index on position instead.

Recommend adding a plain btree index on recorded_at:

CREATE INDEX IF NOT EXISTS positions_recorded_at_idx ON positions (recorded_at);

in both db/init/001_schema.sql (after the existing index block, line 45) and the duplicated block in k8s/base/postgres-configmap.yaml (line 51), matching the existing IF NOT EXISTS idempotent pattern so it's safe to apply via the schema-init Job on redeploy. This is additive and low-risk, but flagging it since it's a schema change alongside an API change.

Files touched
api/src/routes/traffic.ts — new /analytics/traffic/region route + 3 queries + date-range zero-fill helper.
db/init/001_schema.sql and k8s/base/postgres-configmap.yaml — new recorded_at index (recommended, not strictly required for correctness).
Not touched in this plan: frontend/src/lib/api.ts types, TrafficVolumePanel.tsx UI — separate follow-up once this endpoint exists.

Verification
Start the API locally against the dev DB, hit GET /analytics/traffic/region?days=7 directly (curl or browser) and check: totalFlights is a plausible number, daily has exactly 7 zero-filled entries in ascending date order, hourly has 24 entries summing to a number close to totalFlights (not exact — a single flight can span hour buckets).
Confirm totalFlights from /region is larger than any single airport's totalFlights from /airports for the same days, but smaller than the naive sum of all 5 (proving the dedup avoids double-counting).
EXPLAIN ANALYZE the daily/hourly queries before and after adding the recorded_at index to confirm it avoids a sequential scan at days=90.