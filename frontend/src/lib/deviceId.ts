const STORAGE_KEY = "pugetscope_device_id";

// Identifies this browser to the anonymous push-alerts backend — no account
// involved, so this id is the only "auth" a device has (see
// api/src/routes/alerts.ts). Generated once, persisted locally.
export function getDeviceId(): string {
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing) return existing;

  const id = crypto.randomUUID();
  localStorage.setItem(STORAGE_KEY, id);
  return id;
}
