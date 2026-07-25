import { pool } from "../db/postgres.js";

export interface CachedWatch {
  id: number;
  deviceId: string;
  kind: "geofence" | "callsign";
  label: string | null;
  lat: number | null;
  lon: number | null;
  radiusM: number | null;
  maxAltitudeM: number | null;
  matchValue: string | null;
  lastTriggeredAtMs: number | null;
  subscription: { endpoint: string; p256dh: string; auth: string };
}

interface WatchRow {
  id: number;
  device_id: string;
  kind: "geofence" | "callsign";
  label: string | null;
  lat: number | null;
  lon: number | null;
  radius_m: number | null;
  max_altitude_m: number | null;
  match_value: string | null;
  last_triggered_at: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
}

let cache: CachedWatch[] = [];

async function refresh(): Promise<void> {
  const result = await pool.query<WatchRow>(
    `SELECT w.id::int, w.device_id, w.kind, w.label,
            ST_Y(w.location::geometry) AS lat, ST_X(w.location::geometry) AS lon,
            w.radius_m, w.max_altitude_m, w.match_value, w.last_triggered_at,
            s.endpoint, s.p256dh, s.auth
     FROM alert_watches w
     JOIN push_subscriptions s ON s.device_id = w.device_id`,
  );

  cache = result.rows.map((r) => ({
    id: r.id,
    deviceId: r.device_id,
    kind: r.kind,
    label: r.label,
    lat: r.lat,
    lon: r.lon,
    radiusM: r.radius_m,
    maxAltitudeM: r.max_altitude_m,
    matchValue: r.match_value,
    lastTriggeredAtMs: r.last_triggered_at ? new Date(r.last_triggered_at).getTime() : null,
    subscription: { endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth },
  }));
}

export function getWatches(): CachedWatch[] {
  return cache;
}

export function markTriggered(watchId: number, when: Date): void {
  const watch = cache.find((w) => w.id === watchId);
  if (watch) watch.lastTriggeredAtMs = when.getTime();
}

export function removeSubscriptionFromCache(deviceId: string): void {
  cache = cache.filter((w) => w.deviceId !== deviceId);
}

// A refreshed-every-60s in-memory cache, not a live query per update — watch
// create/delete taking up to a minute to take effect is fine, and it keeps
// Postgres load flat regardless of how many aircraft are in a given update
// (unlike ingestion/websocket's other Postgres consumer, this isn't gated by
// an external API's rate limit, so no persisted-cadence bookkeeping needed —
// contrast ingestion/src/enrichment/fidsRefreshWorker.ts).
export function startWatchCache(refreshIntervalMs = 60_000): void {
  refresh().catch((err) => console.error("[websocket] alert watch cache refresh failed:", err));
  setInterval(() => {
    refresh().catch((err) => console.error("[websocket] alert watch cache refresh failed:", err));
  }, refreshIntervalMs);
}
