import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocketPlugin from "@fastify/websocket";
import { config } from "./config.js";
import { getSnapshot, subscriber } from "./db/redis.js";
import { getWatches, startWatchCache } from "./alerts/cache.js";
import { matchWatches, type LiveAircraft } from "./alerts/matching.js";
import { sendAlertNotifications } from "./alerts/notify.js";
import { registry, httpRequestDuration, wsConnections } from "./metrics.js";

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  app.addHook("onResponse", async (req, reply) => {
    httpRequestDuration
      .labels(req.method, req.routeOptions?.url ?? req.url, String(reply.statusCode))
      .observe(reply.elapsedTime / 1000);
  });

  await app.register(cors, { origin: config.corsOrigin });
  await app.register(websocketPlugin);

  const sockets = new Set<import("ws").WebSocket>();

  app.register(async (instance) => {
    instance.get("/live", { websocket: true }, async (socket) => {
      sockets.add(socket);
      wsConnections.set(sockets.size);

      const snapshot = await getSnapshot();
      socket.send(JSON.stringify({ type: "snapshot", data: snapshot }));

      socket.on("close", () => {
        sockets.delete(socket);
        wsConnections.set(sockets.size);
      });
    });
  });

  startWatchCache();

  await subscriber.subscribe("aircraft:updates");
  subscriber.on("message", (_channel, message) => {
    const data: LiveAircraft[] = JSON.parse(message);
    const payload = JSON.stringify({ type: "update", data });
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }

    // Fire-and-forget: alert delivery must never hold up the live position
    // fan-out above.
    const matches = matchWatches(data, getWatches());
    sendAlertNotifications(matches).catch((err) =>
      app.log.error({ err }, "alert notification dispatch failed"),
    );
  });

  app.get("/healthz", async () => ({ ok: true, connections: sockets.size }));

  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", registry.contentType);
    return registry.metrics();
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("[websocket] fatal error:", err);
  process.exit(1);
});
