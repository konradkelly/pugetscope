import "dotenv/config";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { authRoutes } from "./routes/auth.js";
import { aircraftRoutes } from "./routes/aircraft.js";
import { analyticsRoutes } from "./routes/analytics.js";

async function main(): Promise<void> {
  // trustProxy: requests arrive via the nginx Ingress (k8s/base/ingress.yaml),
  // so req.ip needs to come from X-Forwarded-For rather than the ingress
  // pod's own address — otherwise every client shares one rate-limit bucket.
  const app = Fastify({ logger: true, trustProxy: true });

  await app.register(cors, { origin: config.corsOrigin, credentials: true });
  await app.register(cookie);
  // Global default: generous enough for normal use (page loads, aircraft
  // detail lookups) while blocking reload-spam/scripted abuse. Individual
  // routes can tighten this via a per-route `config.rateLimit` override —
  // see analytics.ts for the spatial-join endpoints.
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

  await app.register(authRoutes);
  await app.register(aircraftRoutes);
  await app.register(analyticsRoutes);

  app.get("/healthz", async () => ({ ok: true }));

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("[api] fatal error:", err);
  process.exit(1);
});
