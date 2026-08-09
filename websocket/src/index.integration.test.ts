import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./index.js";
import { redis } from "./db/redis.js";

let app: FastifyInstance;
let baseWsUrl: string;

beforeAll(async () => {
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseWsUrl = `ws://127.0.0.1:${port}/live`;
});

afterAll(async () => {
  await app.close();
});

// A persistent listener attached from the moment the socket opens, buffering
// every frame into a queue — rather than attaching a fresh `once("message")`
// per awaited message, which can miss a frame that arrives in the (however
// brief) gap between two `nextMessage()` calls.
interface TrackedSocket {
  ws: WebSocket;
  queue: unknown[];
  waiters: Array<(msg: unknown) => void>;
}

function connect(): Promise<TrackedSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseWsUrl);
    const tracked: TrackedSocket = { ws, queue: [], waiters: [] };
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      const waiter = tracked.waiters.shift();
      if (waiter) waiter(msg);
      else tracked.queue.push(msg);
    });
    ws.once("open", () => resolve(tracked));
    ws.once("error", reject);
  });
}

function nextMessage(tracked: TrackedSocket): Promise<{ type: string; data: unknown }> {
  if (tracked.queue.length > 0) {
    return Promise.resolve(tracked.queue.shift() as { type: string; data: unknown });
  }
  return new Promise((resolve) => tracked.waiters.push(resolve as (msg: unknown) => void));
}

describe("GET /live — snapshot on connect", () => {
  it("sends an empty snapshot when Redis has no live aircraft", async () => {
    const tracked = await connect();
    try {
      const msg = await nextMessage(tracked);
      expect(msg).toEqual({ type: "snapshot", data: [] });
    } finally {
      tracked.ws.close();
    }
  });

  it("sends the current aircraft:latest:* keys as the initial snapshot", async () => {
    await redis.set("aircraft:latest:abc123", JSON.stringify({ icao24: "abc123", callsign: "TEST1" }));
    await redis.set("aircraft:latest:def456", JSON.stringify({ icao24: "def456", callsign: "TEST2" }));

    const tracked = await connect();
    try {
      const msg = await nextMessage(tracked);
      expect(msg.type).toBe("snapshot");
      const icaos = (msg.data as Array<{ icao24: string }>).map((a) => a.icao24).sort();
      expect(icaos).toEqual(["abc123", "def456"]);
    } finally {
      tracked.ws.close();
    }
  });
});

describe("aircraft:updates pub/sub fan-out", () => {
  it("forwards a published update to a connected client as an 'update' message", async () => {
    const tracked = await connect();
    try {
      await nextMessage(tracked); // consume the initial snapshot first

      const payload = [{ icao24: "live001", callsign: "LIVE1", latitude: 47.45, longitude: -122.31 }];
      // Any client connected to the same Redis db can publish — the
      // websocket service's own `subscriber` (db/redis.ts) is the one
      // listening, independent of which connection issues the publish.
      await redis.publish("aircraft:updates", JSON.stringify(payload));

      const msg = await nextMessage(tracked);
      expect(msg).toEqual({ type: "update", data: payload });
    } finally {
      tracked.ws.close();
    }
  });

  it("fans the same update out to multiple connected clients", async () => {
    const trackedA = await connect();
    const trackedB = await connect();
    try {
      await nextMessage(trackedA);
      await nextMessage(trackedB);

      const payload = [{ icao24: "multi001", callsign: "MULTI1" }];
      await redis.publish("aircraft:updates", JSON.stringify(payload));

      const [msgA, msgB] = await Promise.all([nextMessage(trackedA), nextMessage(trackedB)]);
      expect(msgA).toEqual({ type: "update", data: payload });
      expect(msgB).toEqual({ type: "update", data: payload });
    } finally {
      trackedA.ws.close();
      trackedB.ws.close();
    }
  });
});
