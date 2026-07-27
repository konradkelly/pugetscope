import webpush, { WebPushError } from "web-push";
import { config } from "../config.js";
import { pool } from "../db/postgres.js";
import { markTriggered, removeSubscriptionFromCache } from "./cache.js";
import type { WatchMatch } from "./matching.js";

// web-push validates the stored subscription's keys locally (encryption
// happens client-side before any network call) and throws a plain Error —
// not a WebPushError, which only wraps a non-200 response from the actual
// push service — for a structurally malformed p256dh/auth/endpoint. That
// class of failure is deterministic: it'll fail identically on every future
// match too, so it's treated as dead the same way an HTTP 404/410 is,
// rather than logged forever with no remediation. See
// node_modules/web-push/src/encryption-helper.js for the exact messages.
const MALFORMED_SUBSCRIPTION_RE = /subscription (p256dh|auth)|user (public key|auth)/i;

function isMalformedSubscription(err: unknown): boolean {
  return err instanceof Error && !(err instanceof WebPushError) && MALFORMED_SUBSCRIPTION_RE.test(err.message);
}

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
        // retrying forever. A malformed subscription (see above) is cleaned
        // up the same way, since it can never succeed. Anything else (a
        // different WebPushError status, a network error reaching the push
        // service) is treated as transient and just logged/retried next match.
        const revoked = err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410);
        const malformed = isMalformedSubscription(err);

        if (revoked || malformed) {
          removeSubscriptionFromCache(watch.deviceId);
          await pool
            .query("DELETE FROM push_subscriptions WHERE device_id = $1", [watch.deviceId])
            .catch((deleteErr) => console.error("[websocket] failed to clean up dead subscription:", deleteErr));
          if (malformed) console.error("[websocket] removed a stored subscription with malformed keys:", err);
        } else {
          console.error("[websocket] push send failed:", err);
        }
      }
    }),
  );
}
