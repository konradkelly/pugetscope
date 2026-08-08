// Split out of index.ts so it's importable in tests without triggering that
// module's top-level main() poll loop. Same UTC-anchored LA-date approach as
// api/src/routes/traffic.ts's recentDates() (not shared — see that file's
// REGIONAL_AIRPORTS comment on the project's per-service duplication
// convention).
export function todayLA(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now);
}

export function yesterdayLA(now = new Date()): string {
  const [y, m, d] = todayLA(now).split("-").map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d) - 86_400_000);
  return `${yesterday.getUTCFullYear()}-${String(yesterday.getUTCMonth() + 1).padStart(2, "0")}-${String(yesterday.getUTCDate()).padStart(2, "0")}`;
}
