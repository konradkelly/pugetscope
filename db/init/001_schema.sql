CREATE EXTENSION IF NOT EXISTS postgis;

-- One-off: adsbdb tier removed in favor of AeroDataBox FIDS coverage across
-- all 5 regional airports (see docs/SPEC.md §12) — safe/idempotent to leave
-- here permanently since this script is re-run against the live DB too.
DROP TABLE IF EXISTS flight_routes;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reference/enrichment data — batch-loaded from the OpenSky Aircraft Database.
-- See docs/SPEC.md §7. `first_seen`/`last_seen` track sightings by the ingestion
-- service; the rest is populated by ingestion/src/enrich.ts (npm run enrich).
CREATE TABLE IF NOT EXISTS aircraft (
  icao24 TEXT PRIMARY KEY,
  registration TEXT,
  manufacturer TEXT,
  model TEXT,
  typecode TEXT,
  operator TEXT,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS positions (
  id BIGSERIAL PRIMARY KEY,
  icao24 TEXT NOT NULL REFERENCES aircraft(icao24),
  callsign TEXT,
  position GEOGRAPHY(POINT, 4326) NOT NULL,
  altitude DOUBLE PRECISION,
  ground_speed DOUBLE PRECISION,
  heading DOUBLE PRECISION,
  vertical_speed DOUBLE PRECISION,
  recorded_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS positions_icao24_recorded_at_idx
  ON positions (icao24, recorded_at);

CREATE INDEX IF NOT EXISTS positions_position_gist_idx
  ON positions USING GIST (position);

-- Region-wide traffic queries (analytics/traffic/region) filter on
-- recorded_at alone, with no icao24 or spatial predicate to piggyback on.
CREATE INDEX IF NOT EXISTS positions_recorded_at_idx
  ON positions (recorded_at);

-- Pre-aggregated daily/hourly flight counts per airport (+ 'REGION' for the
-- whole coverage area), maintained incrementally by ingestion
-- (src/db/trafficRollup.ts) so api/src/routes/traffic.ts never has to
-- COUNT(DISTINCT ...) over the full `positions` table per request — see
-- docs/Region-wide-traffic-totals.md and the timeout incident it followed.
CREATE TABLE IF NOT EXISTS traffic_daily_counts (
  scope TEXT NOT NULL CHECK (scope IN ('KSEA','KPAE','KBFI','KRNT','KTIW','REGION')),
  date DATE NOT NULL,
  flights INTEGER NOT NULL,
  PRIMARY KEY (scope, date)
);

-- Separate from traffic_daily_counts rather than derived from it: an
-- aircraft seen across 2 hours legitimately contributes to both hours'
-- counts but only once to the day's total, so summing hourly rows for a day
-- can exceed that day's daily total (see docs/Region-wide-traffic-totals.md).
CREATE TABLE IF NOT EXISTS traffic_hourly_counts (
  scope TEXT NOT NULL CHECK (scope IN ('KSEA','KPAE','KBFI','KRNT','KTIW','REGION')),
  date DATE NOT NULL,
  hour SMALLINT NOT NULL,
  flights INTEGER NOT NULL,
  PRIMARY KEY (scope, date, hour)
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id UUID NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (user_id, key)
);

-- Cached AeroDataBox FIDS board entries, keyed by callsign (see docs/SPEC.md
-- §12 tier 1). Only rows with a non-null call_sign are stored — that's our
-- sole join key against OpenSky's callsign, so a row without one is unusable.
-- Each row describes one leg (this airport is either origin or destination);
-- `other_*` fields describe the opposite end of that leg.
CREATE TABLE IF NOT EXISTS fids_flights (
  airport_icao TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('departure', 'arrival')),
  call_sign TEXT NOT NULL,
  flight_number TEXT,
  status TEXT,
  airline_name TEXT,
  other_icao TEXT,
  other_iata TEXT,
  other_name TEXT,
  other_lat DOUBLE PRECISION,
  other_lon DOUBLE PRECISION,
  scheduled_time TIMESTAMPTZ,
  revised_time TIMESTAMPTZ,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (airport_icao, direction, call_sign)
);

-- Tracks the last successful FIDS refresh per airport so a service
-- restart/redeploy doesn't reset the refresh cadence and burn budget.
CREATE TABLE IF NOT EXISTS fids_refresh_state (
  airport_icao TEXT PRIMARY KEY,
  last_fetched_at TIMESTAMPTZ NOT NULL
);

-- Zip code (ZCTA) boundary polygons, batch-loaded once from Census
-- TIGERweb (ingestion/src/loadZips.ts, npm run load-zips) — a static
-- reference dataset, not something that changes poll-to-poll. Backs
-- noise/overflight-by-neighborhood analytics: a spatial join against
-- `positions` answers "what flew over this zip, and when."
CREATE TABLE IF NOT EXISTS zip_boundaries (
  zcta5 TEXT PRIMARY KEY,
  boundary GEOGRAPHY(MULTIPOLYGON, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS zip_boundaries_boundary_gist_idx
  ON zip_boundaries USING GIST (boundary);

-- Personal spotting log (auth-gated) — the payoff for accounts existing.
-- Each row is a user "logging" a sighting, auto-confirmed server-side
-- against a recent `positions` row (api/src/routes/spottings.ts) rather
-- than trusting a bare client claim, so the log reads as a real logbook
-- instead of a self-reported list.
CREATE TABLE IF NOT EXISTS spottings (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  icao24 TEXT NOT NULL REFERENCES aircraft(icao24),
  spotted_at TIMESTAMPTZ NOT NULL,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  altitude DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS spottings_user_id_spotted_at_idx
  ON spottings (user_id, spotted_at DESC);

CREATE INDEX IF NOT EXISTS spottings_user_id_icao24_idx
  ON spottings (user_id, icao24);

-- Anonymous, device-scoped push alerts — no account required. `device_id` is
-- a UUID generated client-side and kept in localStorage; knowing it is the
-- only "auth" a device has, the same trust model as a bearer token. Meant to
-- double as an on-ramp to a future real (account-based) watchlist.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  device_id UUID PRIMARY KEY,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per watch a device has created. `kind` picks which half of the
-- columns below apply: 'geofence' uses location/radius_m/max_altitude_m,
-- 'callsign' uses match_value (checked against the live callsign or icao24 —
-- see websocket/src/alerts/matching.ts). `last_triggered_at` drives a
-- per-watch cooldown so a loitering aircraft doesn't refire on every ~30s
-- poll (same idea as spottings' DUPLICATE_COOLDOWN_MINUTES).
CREATE TABLE IF NOT EXISTS alert_watches (
  id BIGSERIAL PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES push_subscriptions(device_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('geofence', 'callsign')),
  label TEXT,
  location GEOGRAPHY(POINT, 4326),
  radius_m INTEGER,
  max_altitude_m DOUBLE PRECISION,
  match_value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_triggered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS alert_watches_device_id_idx
  ON alert_watches (device_id);

CREATE INDEX IF NOT EXISTS alert_watches_location_gist_idx
  ON alert_watches USING GIST (location);
