export const config = {
  port: Number(process.env.PORT ?? 3000),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  postgres: {
    connectionString:
      process.env.DATABASE_URL ??
      "postgres://pugetscope:pugetscope@localhost:5433/pugetscope",
  },
  session: {
    cookieName: "pugetscope_session",
    ttlSeconds: 60 * 60 * 24 * 7, // 7 days
    // "secure" cookies require HTTPS — off for local http dev, on elsewhere
    secureCookie: process.env.NODE_ENV === "production",
  },
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
};
