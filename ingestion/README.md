# ingestion

Polls OpenSky for the Puget Sound bbox and writes to Redis (latest positions) and Postgres (history). See [../docs/SPEC.md](../docs/SPEC.md) for the design.

## Dev setup

```
cp .env.example .env   # fill in OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET
npm install
npm run dev
```

## Aircraft reference enrichment

```
npm run enrich
```

One-off batch job: downloads the OpenSky Aircraft Database CSV and fills in `registration`/`manufacturer`/`model`/`typecode`/`operator` for aircraft the poller has already tracked (icao24s already present in the `aircraft` table). Doesn't import the full global database — only enriches rows we actually care about. Not currently scheduled to run automatically; re-run periodically (e.g. monthly) since new aircraft get tracked over time and OpenSky's own snapshot updates irregularly.
