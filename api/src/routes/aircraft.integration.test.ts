import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { pool } from "../db/postgres.js";
import { redis } from "../db/redis.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

async function seedAircraft(icao24: string, overrides: Partial<Record<string, unknown>> = {}) {
  await pool.query(
    `INSERT INTO aircraft (icao24, registration, manufacturer, model, typecode, operator)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      icao24,
      overrides.registration ?? "N12345",
      overrides.manufacturer ?? "Boeing",
      overrides.model ?? "737-800",
      overrides.typecode ?? "B738",
      overrides.operator ?? "Test Air",
    ],
  );
}

describe("GET /aircraft", () => {
  it("returns an empty array when nothing is live in Redis", async () => {
    const res = await app.inject({ method: "GET", url: "/aircraft" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("returns every aircraft:latest:* entry from Redis", async () => {
    await redis.set("aircraft:latest:abc123", JSON.stringify({ icao24: "abc123", callsign: "TEST1" }));
    await redis.set("aircraft:latest:def456", JSON.stringify({ icao24: "def456", callsign: "TEST2" }));

    const res = await app.inject({ method: "GET", url: "/aircraft" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ icao24: string }>;
    expect(body.map((a) => a.icao24).sort()).toEqual(["abc123", "def456"]);
  });
});

describe("GET /aircraft/:icao24", () => {
  it("returns 404 when the aircraft is in neither Redis nor Postgres", async () => {
    const res = await app.inject({ method: "GET", url: "/aircraft/ffffff" });
    expect(res.statusCode).toBe(404);
  });

  it("merges live Redis state with the Postgres reference row", async () => {
    await seedAircraft("abc123", { registration: "N99XY", manufacturer: "Cessna" });
    await redis.set(
      "aircraft:latest:abc123",
      JSON.stringify({ icao24: "abc123", callsign: "LIVE1", latitude: 47.45 }),
    );

    const res = await app.inject({ method: "GET", url: "/aircraft/abc123" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ icao24: "abc123", registration: "N99XY", manufacturer: "Cessna" });
    expect(body.latest).toMatchObject({ callsign: "LIVE1", latitude: 47.45 });
  });

  it("returns the Postgres reference row alone (latest: null) when not currently live", async () => {
    await seedAircraft("dead001");
    const res = await app.inject({ method: "GET", url: "/aircraft/dead001" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.icao24).toBe("dead001");
    expect(body.latest).toBeNull();
  });

  it("returns the live Redis state alone when there's no Postgres reference row yet", async () => {
    await redis.set(
      "aircraft:latest:newicao",
      JSON.stringify({ icao24: "newicao", callsign: "BRAND1" }),
    );
    const res = await app.inject({ method: "GET", url: "/aircraft/newicao" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.latest).toMatchObject({ callsign: "BRAND1" });
    expect(body.registration).toBeUndefined();
  });
});
