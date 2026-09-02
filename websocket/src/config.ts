export const config = {
  port: Number(process.env.PORT ?? 3001),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  postgres: {
    connectionString:
      process.env.DATABASE_URL ??
      "postgres://pugetscope:pugetscope@localhost:5433/pugetscope",
    // Same tradeoff as api/src/config.ts: encrypted but not certificate-verified.
    ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  },
  // Push alerts — unset VAPID keys disable alert delivery entirely rather
  // than crashing the service, since the websocket service's core job (live
  // position fan-out) doesn't depend on them.
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY ?? "",
    privateKey: process.env.VAPID_PRIVATE_KEY ?? "",
    subject: process.env.VAPID_SUBJECT ?? "mailto:admin@pugetscope.com",
  },
  // Email alerts — same optional/log-instead-of-crash posture as vapid
  // above, mirroring api/src/config.ts's email block.
  email: {
    fromAddress: process.env.SES_FROM_EMAIL ?? null,
    region: process.env.AWS_REGION ?? "us-west-2",
  },
};
