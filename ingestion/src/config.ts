function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  opensky: {
    clientId: requireEnv("OPENSKY_CLIENT_ID"),
    clientSecret: requireEnv("OPENSKY_CLIENT_SECRET"),
    tokenUrl:
      "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
    statesUrl: "https://opensky-network.org/api/states/all",
  },
  // Puget Sound bounding box — see docs/SPEC.md §3 (~1.8 sq°, 1 credit/poll)
  bbox: {
    lamin: 47.0,
    lomin: -123.2,
    lamax: 48.4,
    lomax: -121.9,
  },
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 30_000),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  redisKeyTtlSeconds: 90, // a couple missed polls before a key is considered stale
  postgres: {
    connectionString:
      process.env.DATABASE_URL ??
      "postgres://pugetscope:pugetscope@localhost:5432/pugetscope",
  },
};
