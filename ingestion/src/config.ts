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
    // OpenSky blocks connections from AWS IP ranges (confirmed by testing —
    // times out from EC2, succeeds from every other network tried). Routes
    // through a non-AWS forward proxy when set; direct connection otherwise
    // (e.g. local dev). "http://user:pass@host:port" — auth is optional.
    proxyUrl: process.env.OPENSKY_PROXY_URL || null,
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
    // See api/src/config.ts for why this is conditional and why
    // rejectUnauthorized is false.
    ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  },
  // Optional (not requireEnv): FIDS is an opt-in tier-1 enrichment (docs/SPEC.md
  // §12) — without a key, attachRoutes just falls back to tiers 2/3 as before.
  aerodatabox: {
    apiKey: process.env.AERODATABOX_API_KEY ?? null,
    // RapidAPI ULTRA plan: 60,000 units/mo, FIDS is a TIER 2 endpoint (2
    // units/call) -> 30,000 calls/mo budget. At one airport, the deployed 5 min
    // interval is ~8.6k calls/mo, well under that. See docs/SPEC.md §12.
    airportIcao: process.env.FIDS_AIRPORT_ICAO ?? "KSEA",
    // IANA timezone of the FIDS airport — AeroDataBox expects local-time query
    // windows, so this must match FIDS_AIRPORT_ICAO's actual timezone.
    airportTz: process.env.FIDS_AIRPORT_TZ ?? "America/Los_Angeles",
    refreshIntervalMs: Number(process.env.FIDS_REFRESH_INTERVAL_MS ?? 3 * 60 * 60 * 1000), // fallback only; deployment sets 5 min
  },
};
