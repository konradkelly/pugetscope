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

// 404/410 means the browser revoked or expired the subscription (uninstalled,
// cleared data, etc.) — clean it up rather than retrying forever. A malformed
// subscription (see MALFORMED_SUBSCRIPTION_RE) is cleaned up the same way,
// since it can never succeed.
async function cleanupDeadSubscription(deviceId: string, malformed: boolean, err: unknown): Promise<void> {
  removeSubscriptionFromCache(deviceId);
  try {
    // If this device happens to be the *creating* device_id of an
    // account-linked watch, hand the watch off to another of the account's
    // live devices first. Without this, alert_watches.device_id's
    // ON DELETE CASCADE would destroy the whole watch below just because
    // this one device's subscription died — killing delivery to every other
    // device too, which would quietly defeat the point of account-linked
    // delivery. If there's no other live device for the account (or the
    // watch isn't account-linked at all), this is a no-op and the CASCADE
    // proceeds exactly as it always has.
    await pool.query(
      `WITH replacement AS (
         SELECT w.id AS watch_id, s2.device_id AS new_device_id
         FROM alert_watches w
         JOIN LATERAL (
           SELECT device_id FROM push_subscriptions
           WHERE user_id = w.user_id AND device_id <> $1
           LIMIT 1
         ) s2 ON true
         WHERE w.device_id = $1 AND w.user_id IS NOT NULL
       )
       UPDATE alert_watches w SET device_id = replacement.new_device_id
       FROM replacement WHERE w.id = replacement.watch_id`,
      [deviceId],
    );
    await pool.query("DELETE FROM push_subscriptions WHERE device_id = $1", [deviceId]);
  } catch (cleanupErr) {
    console.error("[websocket] failed to clean up dead subscription:", cleanupErr);
  }
  if (malformed) console.error("[websocket] removed a stored subscription with malformed keys:", err);
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

      // A watch may have several subscriptions (see CachedWatch.subscriptions
      // in cache.ts) — one per device the account has push-enabled, for an
      // account-linked watch, or just the one creating device otherwise.
      // Send to each independently; one device's failure/cleanup shouldn't
      // affect delivery to the others.
      let anySucceeded = false;
      await Promise.all(
        watch.subscriptions.map(async (subscription) => {
          try {
            await webpush.sendNotification(
              {
                endpoint: subscription.endpoint,
                keys: { p256dh: subscription.p256dh, auth: subscription.auth },
              },
              payload,
            );
            anySucceeded = true;
          } catch (err) {
            const revoked = err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410);
            const malformed = isMalformedSubscription(err);

            if (revoked || malformed) {
              await cleanupDeadSubscription(subscription.deviceId, malformed, err);
            } else {
              // Anything else (a different WebPushError status, a network
              // error reaching the push service) is treated as transient and
              // just logged/retried next match.
              console.error("[websocket] push send failed:", err);
            }
          }
        }),
      );

      if (anySucceeded) {
        markTriggered(watch.id, now);
        await pool.query("UPDATE alert_watches SET last_triggered_at = $1 WHERE id = $2", [now, watch.id]);
      }
    }),
  );
}
