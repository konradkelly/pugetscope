Aircraft type visual differentiation (map markers)

Context
Every aircraft on the map renders as the same hand-drawn SVG glyph today — only size and shape never vary, just color (sky-blue normal, violet when selected), per `createMarkerElement()` in `frontend/src/components/AircraftMap.tsx:35-44`. That function's own comment flags it as "Placeholder icon — pending tar1090 icon-set license check" (docs/SPEC.md §10), so there's no existing type-based rendering to build on.

The data to distinguish aircraft already exists in the OpenSky feed but is silently dropped: the raw REST response includes an ADS-B emitter category at `row[17]` (see the `RawStateRow` type comment at `ingestion/src/openskyClient.ts:54`), but `parseRow()` (`openskyClient.ts:96-114`) never reads it, so it never reaches `StateVector`, Redis, the websocket feed, or the frontend.

Separately, the `aircraft` Postgres table (`db/init/001_schema.sql:18-27`) has `typecode`/`manufacturer` from the OpenSky metadata CSV, exposed via `GET /aircraft/:icao24`. That's a per-icao24 lookup keyed off a batch-loaded reference table (populated by `npm run enrich`) and won't have every icao24 covered. The live `category` field is simpler — it rides along with every state vector, no join required — so this plan uses it as the primary signal and treats `typecode` as an optional future refinement (e.g. distinguishing widebody from narrowbody within "large").

Approach

1. Thread `category` through the live pipeline (backend, no DB migration needed)
   - Add `category: number | null` to `StateVector` in `ingestion/src/openskyClient.ts:17-33`.
   - In `parseRow()` (`openskyClient.ts:96-114`), read `row[17] ?? null`.
   - No schema change needed downstream: `writeLatestPositions()` (`ingestion/src/db/redis.ts:7-31`) JSON-serializes the whole state object into Redis and pub/sub as-is, and the websocket service (`websocket/src/index.ts:20-33`) relays that JSON verbatim with no field allowlisting. So the new field reaches the frontend for free once it's on `StateVector`.
   - Mirror the new field onto the frontend's `StateVector` type in `frontend/src/lib/useAircraftFeed.ts:24-42`.
   - This is a live-feed-only concern — `category` does not need to land in the `positions` table. That table backs historical/analytics queries (traffic volume, spotting log, noise-by-neighborhood), none of which currently care about aircraft class. Skip the DB migration entirely unless a future analytics feature needs it.

2. Classify category into a small render-relevant set
   ADS-B emitter category (DO-260B) has ~20 values; collapse them into a handful of buckets that actually change how something should look on a map:

   | category value(s) | bucket        | marker treatment                    |
   |--------------------|---------------|--------------------------------------|
   | 5, 6               | heavy/wide    | largest glyph, distinct "wide" shape |
   | 3, 4               | large         | medium-large glyph, standard shape   |
   | 2                  | small/GA      | small glyph, standard shape          |
   | 8                  | rotorcraft    | rotor glyph (distinct silhouette)    |
   | 9                  | glider        | glider glyph                         |
   | 10, 11, 12         | ultralight/LTA| smallest glyph                       |
   | 14                 | UAV/drone     | distinct drone glyph                 |
   | 0, 1, null         | unknown       | current default glyph/size (fallback — most GA and many airliners without ADS-B category support will land here, so this bucket must look reasonable, not degraded) |
   | 16, 17, 18, 19, 20 | ground/obstacle | (out of scope — these aren't really "aircraft"; consider filtering them out of the feed entirely as a follow-up) |

   Put this mapping in one place — a small `frontend/src/lib/aircraftCategory.ts` module exporting `classifyCategory(category: number | null): AircraftClass` — rather than inlining a switch inside the map component, since the legend (below) needs the same classification.

3. Update marker rendering (`AircraftMap.tsx`)
   - `createMarkerElement()` takes an `AircraftClass` param and picks glyph + size accordingly (viewBox/width/height scaled per bucket, e.g. 14px small → 26px heavy). Keep using `currentColor` + Tailwind text-color classes so the existing selected/unselected color-swap logic (lines 117-119) keeps working unmodified.
   - Since class is now derived from live data that can arrive after the marker element is first created (a snapshot's first message may lack category momentarily), re-derive class on every update pass (inside the existing `for (const [icao24, state] of aircraft)` loop at line 96) and swap the glyph's size/shape classes the same way color is swapped today, rather than only setting it at marker creation.
   - Reserve color for a second dimension so it doesn't just duplicate size — altitude band (on-ground / below 10,000ft / cruise) is the natural fit since `baroAltitude`/`onGround` are already on every state vector, and it's a common convention in flight-tracking tools (e.g. tar1090).

4. Add a legend
   - No legend exists anywhere in the UI currently. Once shape/size/color carry meaning, a legend is necessary, not optional — a floating panel matching the existing card style (`bg-white/95 backdrop-blur shadow-lg`, consistent with `AircraftDetailPanel`/other panels in `App.tsx`), placed bottom-left or bottom-right near the existing status pill / toggle buttons.
   - Content: one row per bucket showing the actual marker glyph at its real size + a label ("Heavy/Wide", "Rotorcraft", etc.), plus the altitude-band color key if step 3's color dimension ships.
   - Use the `dataviz` skill when actually building this panel — legend layout/color-key conventions are exactly what it covers.

Resolved: icon set
tar1090 itself is GPLv2+, and pugetscope has no LICENSE file of its own (implicitly proprietary) — vendoring its actual icon SVGs would mean GPL-licensed source going into the bundle and very likely forces a GPLv2+ LICENSE onto the combined work. Decision: draw original SVG silhouettes inspired by tar1090's visual conventions (nose-up orientation, silhouette-by-category) but not copied from it — see `frontend/src/lib/aircraftCategory.ts`. No GPL encumbrance, no attribution requirement.

Resolved: category coverage turned out too sparse to use alone
Shipping the category-only version against live traffic (running the full stack locally) surfaced two real gaps:

1. OpenSky's `/states/all` omits field 17 entirely unless the request includes `extended=1` — without it, `row[17]` is `undefined`, not `null`, so every aircraft parsed as `category: null`. Fixed in `fetchPugetSoundStates()` (`ingestion/src/openskyClient.ts`).
2. Even with `extended=1`, live Puget Sound traffic showed ~98% of aircraft (92/94 in one sample) broadcasting category 0 ("no information at all") — the category field just isn't reliably sent by most transponders/feeders in practice, especially GA. So category alone can't deliver "big commercial vs. small private" — nearly everything falls into "unknown."

Fix: `typecode` (the ICAO type designator, e.g. "B738", "C172") from the `aircraft` reference table is the primary classifier now, since it doesn't depend on what an aircraft happens to broadcast — only on whether `npm run enrich` has run against it. Category is kept as the fallback for icao24s not yet enriched.

- `ingestion/src/enrichment/attachAircraftType.ts` — new enrichment step, joins `aircraft.typecode` per icao24 (batch query, same shape as `attachRoutes.ts`), attached in `index.ts`'s `pollOnce()` after `attachRoutes`/`insertPositions`.
- `frontend/src/lib/aircraftCategory.ts` — added `classifyTypecode()` (exact-match table built from typecodes actually observed in this project's feed, plus a light manufacturer-family prefix fallback) and `classifyAircraft()` (typecode first, category fallback). Explicitly not an exhaustive DOC 8643 type-designator list — extend `EXACT_TYPECODE_CLASS` as new types turn up.
- `AircraftMap.tsx` now calls `classifyAircraft(state)` instead of `classifyCategory(state.category)`.
- Verified end-to-end against the live local stack (all 5 services + real OpenSky traffic): 67-73% of currently-tracked aircraft get a typecode match, producing real visual variety (heavy jets near SeaTac/Boeing Field, small GA crosses around Vashon/Bremerton/Gig Harbor, a rotorcraft glyph over Tukwila) rather than one uniform icon.

Open questions
- Whether to filter out ground-vehicle/obstacle categories (16-20) at the ingestion level rather than rendering them as tiny aircraft — worth deciding once real traffic is inspected for how often they actually appear in the Puget Sound feed.
- `EXACT_TYPECODE_CLASS`/`TYPECODE_PREFIX_CLASS` coverage is best-effort, not authoritative — some real typecodes (e.g. `C77R`, `DH3T` observed live) don't match and fall through to the category fallback (usually "unknown"). Fine for now; expand the table opportunistically.
- `npm run enrich` needs to be (re-)run periodically as new icao24s are first tracked — it only updates rows already in the `aircraft` table, so a freshly-seen aircraft has no typecode until the next enrich run. Worth scheduling (e.g. a periodic job) rather than relying on someone remembering to run it by hand.

Out of scope for this plan
- Dark mode / map style swap, legend visual polish beyond basic layout, and replacing the emoji icons elsewhere in `App.tsx` — these were raised in the same brainstorm but are independent visual work, not blocked by or blocking this plan.
