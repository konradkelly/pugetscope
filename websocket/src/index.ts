import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocketPlugin from "@fastify/websocket";
import { config } from "./config.js";
import { getSnapshot, subscriber } from "./db/redis.js";

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: config.corsOrigin });
  await app.register(websocketPlugin);

  const sockets = new Set<import("ws").WebSocket>();

  app.register(async (instance) => {
    instance.get("/live", { websocket: true }, async (socket) => {
      sockets.add(socket);

      const snapshot = await getSnapshot();
      socket.send(JSON.stringify({ type: "snapshot", data: snapshot }));

      socket.on("close", () => sockets.delete(socket));
    });
  });

  await subscriber.subscribe("aircraft:updates");
  subscriber.on("message", (_channel, message) => {
    const payload = JSON.stringify({ type: "update", data: JSON.parse(message) });
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  });

  app.get("/healthz", async () => ({ ok: true, connections: sockets.size }));

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("[websocket] fatal error:", err);
  process.exit(1);
});
