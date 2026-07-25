import { api } from "./api.js";
import { config } from "./config.js";
import { getDeviceId } from "./deviceId.js";

// Standard VAPID-key conversion — pushManager.subscribe wants the
// applicationServerKey as a Uint8Array, VAPID public keys are handed out
// base64url-encoded.
function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && config.vapidPublicKey !== "";
}

/**
 * Registers the service worker (if needed), requests notification
 * permission (must be called from a user gesture), subscribes to push, and
 * registers the subscription with the backend. Returns the device id on
 * success so the caller can attach watches to it.
 */
export async function ensurePushSubscription(): Promise<string> {
  if (!pushSupported()) {
    throw new Error("push notifications aren't supported in this browser");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("notification permission denied");
  }

  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
    });
  }

  const deviceId = getDeviceId();
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("push subscription is missing required fields");
  }

  await api.subscribePush(deviceId, {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });

  return deviceId;
}
