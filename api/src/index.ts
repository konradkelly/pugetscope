import "dotenv/config";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { authRoutes } from "./routes/auth.js";
import { aircraftRoutes } from "./routes/aircraft.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { trafficRoutes } from "./routes/traffic.js";
import { airportsRoutes } from "./routes/airports.js";
import { spottingsRoutes } from "./routes/spottings.js";
import { alertsRoutes } from "./routes/alerts.js";
import { preferencesRoutes } from "./routes/preferences.js";
import { replayRoutes } from "./routes/replay.js";
import { digestRoutes } from "./routes/digest.js";
import { registry, httpRequestDuration } from "./metrics.js";

async function main(): Promise<void> {
  // trustProxy: requests arrive via the nginx Ingress (k8s/base/ingress.yaml),
  // so req.ip needs to come from X-Forwarded-For rather than the ingress
  // pod's own address — otherwise every client shares one rate-limit bucket.
  const app = Fastify({ logger: true, trustProxy: true });

  // routeOptions.url is the route pattern (e.g. "/aircraft/:icao24"), not the
  // resolved path — keeps the route label low-cardinality. Falls back to the
  // raw url for unmatched routes (404s), which routeOptions doesn't have.
  app.addHook("onResponse", async (req, reply) => {
    httpRequestDuration
      .labels(req.method, req.routeOptions?.url ?? req.url, String(reply.statusCode))
      .observe(reply.elapsedTime / 1000);
  });

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
  await app.register(trafficRoutes);
  await app.register(airportsRoutes);
  await app.register(spottingsRoutes);
  await app.register(alertsRoutes);
  await app.register(preferencesRoutes);
  await app.register(replayRoutes);
  await app.register(digestRoutes);

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", registry.contentType);
    return registry.metrics();
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("[api] fatal error:", err);
  process.exit(1);
});
