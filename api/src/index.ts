import "dotenv/config";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { authRoutes } from "./routes/auth.js";
import { aircraftRoutes } from "./routes/aircraft.js";
import { analyticsRoutes } from "./routes/analytics.js";

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: config.corsOrigin, credentials: true });
  await app.register(cookie);

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
