import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";

let app: FastifyInstance;
let xff = 0;
// A fresh X-Forwarded-For per call gives each request its own rate-limit
// bucket (/alerts/subscribe and /alerts/watches POST are both capped at
// 20/min) — without it, the per-device-cap test alone (11 POSTs) plus every
// other test's calls in this file adds up close enough to that ceiling that
// an unrelated future test could start failing on 429s, not real logic.
function headers() {
  xff += 1;
  return { "x-forwarded-for": `10.0.1.${xff}` };
}

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

function subscription() {
  return {
    endpoint: `https://push.example.com/${randomUUID()}`,
    keys: { p256dh: "p256dh-key-value", auth: "auth-key-value" },
  };
}

async function subscribe(deviceId: string) {
  return app.inject({
    method: "POST",
    url: "/alerts/subscribe",
    headers: headers(),
    payload: { deviceId, subscription: subscription() },
  });
}

async function createWatch(payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/alerts/watches", headers: headers(), payload });
}

describe("POST /alerts/subscribe", () => {
  it("rejects a non-UUID deviceId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/alerts/subscribe",
      headers: headers(),
      payload: { deviceId: "not-a-uuid", subscription: subscription() },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a missing subscription", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/alerts/subscribe",
      headers: headers(),
      payload: { deviceId: randomUUID() },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts a valid subscription with 204", async () => {
    const res = await subscribe(randomUUID());
    expect(res.statusCode).toBe(204);
  });
});

describe("POST /alerts/watches — geofence", () => {
  it("requires an existing push subscription first (404)", async () => {
    const res = await createWatch({
      deviceId: randomUUID(), kind: "geofence", lat: 47.45, lon: -122.31, radiusM: 5000,
    });
    expect(res.statusCode).toBe(404);
  });

  it("creates a geofence watch and round-trips lat/lon through GET (PostGIS ST_X/ST_Y)", async () => {
    const deviceId = randomUUID();
    await subscribe(deviceId);

    const createRes = await createWatch({
      deviceId, kind: "geofence", label: "Home",
      lat: 47.4502, lon: -122.3088, radiusM: 5000, maxAltitudeM: 3000,
    });
    expect(createRes.statusCode).toBe(201);
    const { id } = createRes.json();

    const listRes = await app.inject({ method: "GET", url: `/alerts/watches?deviceId=${deviceId}` });
    expect(listRes.statusCode).toBe(200);
    const { watches } = listRes.json();
    expect(watches).toHaveLength(1);
    expect(watches[0]).toMatchObject({ id, kind: "geofence", label: "Home", radiusM: 5000, maxAltitudeM: 3000 });
    // Geography round-trips as floating point — small tolerance, not exact equality.
    expect(watches[0].lat).toBeCloseTo(47.4502, 4);
    expect(watches[0].lon).toBeCloseTo(-122.3088, 4);
  });

  it("rejects an out-of-range latitude", async () => {
    const deviceId = randomUUID();
    await subscribe(deviceId);
    const res = await createWatch({ deviceId, kind: "geofence", lat: 200, lon: -122.31, radiusM: 5000 });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a radius outside the allowed bounds", async () => {
    const deviceId = randomUUID();
    await subscribe(deviceId);
    const res = await createWatch({ deviceId, kind: "geofence", lat: 47.45, lon: -122.31, radiusM: 50 });
    expect(res.statusCode).toBe(400);
  });

  it("enforces the per-device cap of 10 watches", async () => {
    const deviceId = randomUUID();
    await subscribe(deviceId);

    for (let i = 0; i < 10; i++) {
      const res = await createWatch({ deviceId, kind: "geofence", lat: 47.45, lon: -122.31, radiusM: 1000 });
      expect(res.statusCode).toBe(201);
    }

    const overCap = await createWatch({ deviceId, kind: "geofence", lat: 47.45, lon: -122.31, radiusM: 1000 });
    expect(overCap.statusCode).toBe(409);
  });
});

describe("POST /alerts/watches — callsign", () => {
  it("uppercases and trims matchValue", async () => {
    const deviceId = randomUUID();
    await subscribe(deviceId);

    const createRes = await createWatch({ deviceId, kind: "callsign", matchValue: "  n12345  " });
    expect(createRes.statusCode).toBe(201);

    const listRes = await app.inject({ method: "GET", url: `/alerts/watches?deviceId=${deviceId}` });
    const { watches } = listRes.json();
    expect(watches[0].matchValue).toBe("N12345");
  });

  it("rejects an invalid matchValue", async () => {
    const deviceId = randomUUID();
    await subscribe(deviceId);
    const res = await createWatch({ deviceId, kind: "callsign", matchValue: "not valid!" });
    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /alerts/watches/:id", () => {
  it("deletes a watch owned by the requesting device", async () => {
    const deviceId = randomUUID();
    await subscribe(deviceId);
    const createRes = await createWatch({ deviceId, kind: "callsign", matchValue: "N54321" });
    const { id } = createRes.json();

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/alerts/watches/${id}?deviceId=${deviceId}`,
    });
    expect(deleteRes.statusCode).toBe(204);

    const listRes = await app.inject({ method: "GET", url: `/alerts/watches?deviceId=${deviceId}` });
    expect(listRes.json().watches).toHaveLength(0);
  });

  it("returns 404 when a different device tries to delete someone else's watch", async () => {
    const ownerDeviceId = randomUUID();
    await subscribe(ownerDeviceId);
    const createRes = await createWatch({ deviceId: ownerDeviceId, kind: "callsign", matchValue: "N11111" });
    const { id } = createRes.json();

    const otherDeviceId = randomUUID();
    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/alerts/watches/${id}?deviceId=${otherDeviceId}`,
    });
    expect(deleteRes.statusCode).toBe(404);
  });
});
