import { pool } from "../db/postgres.js";

export interface CachedWatchSubscription {
  deviceId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

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
  // userId/email are only ever non-null together (opt-in requires an
  // account — see the notify_email column comment in db/init/001_schema.sql).
  userId: string | null;
  notifyEmail: boolean;
  email: string | null;
  // One entry per device that should be notified for this watch: always the
  // creating device (deviceId, above), plus — for an account-linked watch —
  // every other device the same account has push-enabled. See refresh()'s
  // query for how that fan-out is resolved.
  subscriptions: CachedWatchSubscription[];
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
  user_id: string | null;
  notify_email: boolean;
  email: string | null;
  sub_device_id: string;
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
            w.user_id, w.notify_email, u.email,
            s.device_id AS sub_device_id, s.endpoint, s.p256dh, s.auth
     FROM alert_watches w
     JOIN push_subscriptions s
       -- A watch always delivers to the device that created it (device_id
       -- match); when it's account-linked (user_id set), it also fans out to
       -- every other device the same account has push-enabled. This is a
       -- single OR-join, not a UNION, so it can't produce duplicate rows —
       -- and push_subscriptions.device_id is a PK, so each subscription row
       -- matches a given watch at most once. Note: if two accounts log into
       -- the same browser sequentially, the later login retags that device's
       -- user_id, so the earlier account's other watches quietly stop
       -- fanning out to it here — a shared-device side effect, not a bug.
       ON s.device_id = w.device_id OR (w.user_id IS NOT NULL AND s.user_id = w.user_id)
     LEFT JOIN users u ON u.id = w.user_id`,
  );

  const watchesById = new Map<number, CachedWatch>();
  for (const r of result.rows) {
    let watch = watchesById.get(r.id);
    if (!watch) {
      watch = {
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
        userId: r.user_id,
        notifyEmail: r.notify_email,
        email: r.email,
        subscriptions: [],
      };
      watchesById.set(r.id, watch);
    }
    watch.subscriptions.push({ deviceId: r.sub_device_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth });
  }

  cache = [...watchesById.values()];
}

export function getWatches(): CachedWatch[] {
  return cache;
}

export function markTriggered(watchId: number, when: Date): void {
  const watch = cache.find((w) => w.id === watchId);
  if (watch) watch.lastTriggeredAtMs = when.getTime();
}

// A dead/revoked subscription only ever disqualifies the one device it
// belongs to — a watch may still have other live subscriptions (see
// CachedWatch.subscriptions above), so this trims the array rather than
// dropping the watch itself.
export function removeSubscriptionFromCache(deviceId: string): void {
  for (const watch of cache) {
    watch.subscriptions = watch.subscriptions.filter((s) => s.deviceId !== deviceId);
  }
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
