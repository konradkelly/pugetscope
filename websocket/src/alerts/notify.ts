import webpush from "web-push";
import { config } from "../config.js";
import { pool } from "../db/postgres.js";
import { markTriggered, removeSubscriptionFromCache } from "./cache.js";
import type { WatchMatch } from "./matching.js";

let configured = false;

function ensureConfigured(): boolean {
  if (!config.vapid.publicKey || !config.vapid.privateKey) return false;
  if (!configured) {
    webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
    configured = true;
  }
  return true;
}

export async function sendAlertNotifications(matches: WatchMatch[]): Promise<void> {
  if (matches.length === 0 || !ensureConfigured()) return;

  await Promise.all(
    matches.map(async ({ watch, aircraft }) => {
      const now = new Date();
      const payload = JSON.stringify({
        title: watch.label || (watch.kind === "geofence" ? "Aircraft nearby" : "Aircraft spotted"),
        body: aircraft.callsign?.trim() || aircraft.icao24,
        icao24: aircraft.icao24,
      });

      try {
        await webpush.sendNotification(
          {
            endpoint: watch.subscription.endpoint,
            keys: { p256dh: watch.subscription.p256dh, auth: watch.subscription.auth },
          },
          payload,
        );
        markTriggered(watch.id, now);
        await pool.query("UPDATE alert_watches SET last_triggered_at = $1 WHERE id = $2", [now, watch.id]);
      } catch (err) {
        // 404/410 means the browser revoked or expired the subscription
        // (uninstalled, cleared data, etc.) — clean it up rather than
        // retrying forever. Anything else is a transient send failure.
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          removeSubscriptionFromCache(watch.deviceId);
          await pool
            .query("DELETE FROM push_subscriptions WHERE device_id = $1", [watch.deviceId])
            .catch((deleteErr) => console.error("[websocket] failed to clean up dead subscription:", deleteErr));
        } else {
          console.error("[websocket] push send failed:", err);
        }
      }
    }),
  );
}
