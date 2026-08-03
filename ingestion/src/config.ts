function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  // Getters, not eagerly-evaluated properties: generateDigest.ts (and the
  // other one-off scripts — enrich.ts, loadZips.ts, backfillTrafficRollup.ts)
  // import this same config module just for config.postgres/config.anthropic
  // via db/postgres.ts, and the digest-generate CronJob deliberately only
  // gets Postgres + Anthropic env vars (it never touches OpenSky). A plain
  // eager requireEnv() here threw on import for that pod before any of
  // generateDigest.ts's own code ran — caught live against the real
  // digest-generate CronJob in prod. Real ingestion (openskyClient.ts) still
  // fails just as fast, the first time it actually reads config.opensky.*.
  opensky: {
    get clientId() {
      return requireEnv("OPENSKY_CLIENT_ID");
    },
    get clientSecret() {
      return requireEnv("OPENSKY_CLIENT_SECRET");
    },
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
  // Deliberately much coarser than pollIntervalMs: traffic/overflight rollups
  // re-scan the full today+yesterday `positions` window on every refresh
  // (see trafficRollup.ts/overflightRollup.ts), so running them at 30s
  // cadence was 10x more ST_Intersects/ST_DWithin load than the hourly
  // rollup buckets actually need — a real contributor to prod DB CPU/memory
  // pressure. Poll cadence itself stays at 30s (map freshness); only the
  // rollup recompute is decoupled to this slower interval.
  rollupRefreshIntervalMs: Number(process.env.ROLLUP_REFRESH_INTERVAL_MS ?? 5 * 60 * 1000),
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
  // §12) — without a key, attachRoutes just falls back to tier 2 (own-track
  // inference) as before.
  aerodatabox: {
    apiKey: process.env.AERODATABOX_API_KEY ?? null,
    // IANA timezone of the FIDS airports — AeroDataBox expects local-time query
    // windows. All 5 regional airports (see regionalAirports.ts) share this zone.
    airportTz: process.env.FIDS_AIRPORT_TZ ?? "America/Los_Angeles",
    // RapidAPI ULTRA plan: 60,000 units/mo, FIDS is a TIER 2 endpoint (2
    // units/call) -> 30,000 calls/mo budget. KSEA at 5 min = ~8.6k calls/mo
    // (~17.3k units); the other 4 regional fields at 10 min = ~4.3k calls/mo
    // each (~34.6k units total) — combined ~51.8k units/mo, ~14% headroom.
    // See docs/SPEC.md §12.
    primaryRefreshIntervalMs: Number(process.env.FIDS_PRIMARY_REFRESH_INTERVAL_MS ?? 3 * 60 * 60 * 1000), // fallback only; deployment sets 5 min for KSEA
    secondaryRefreshIntervalMs: Number(process.env.FIDS_SECONDARY_REFRESH_INTERVAL_MS ?? 3 * 60 * 60 * 1000), // fallback only; deployment sets 10 min for PAE/BFI/RNT/TIW
  },
  // Optional (not requireEnv): gates generateDigest.ts, a one-off nightly
  // script, not the always-on poll loop — same opt-in posture as aerodatabox.
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? null,
  },
};
