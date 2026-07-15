export const config = {
  port: Number(process.env.PORT ?? 3000),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  postgres: {
    connectionString:
      process.env.DATABASE_URL ??
      "postgres://pugetscope:pugetscope@localhost:5433/pugetscope",
    // RDS enforces SSL by default (rds.force_ssl in its default parameter
    // group); the local in-cluster Postgres container doesn't have SSL
    // configured at all. rejectUnauthorized: false because Node's default
    // trust store doesn't include Amazon's RDS CA — encrypted but not
    // certificate-verified, a deliberate simplification for a portfolio
    // project (same tradeoff class as Redis having no AUTH/TLS).
    ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  },
  session: {
    cookieName: "pugetscope_session",
    ttlSeconds: 60 * 60 * 24 * 7, // 7 days
    // "secure" cookies require HTTPS — off for local http dev, on elsewhere
    secureCookie: process.env.NODE_ENV === "production",
  },
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
};
