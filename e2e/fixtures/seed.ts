// One-shot fixture seeding for e2e — run via `npm run seed`, NOT a Vitest
// file. Deliberately bypasses live ingestion (see docker-compose e2e
// bring-up: `postgres redis api websocket frontend`, ingestion omitted)
// since real OpenSky polling is network-flaky, needs real credentials, and
// produces non-deterministic aircraft counts — exactly what e2e must avoid.
//
// Redis is seeded through ingestion's own writeLatestPositions (imported
// directly, not duplicated) rather than hand-rolling the aircraft:latest:*
// key shape — a deliberate one-off exception to this repo's usual
// per-service-duplication convention (see websocket/src/alerts/matching.ts's
// haversine comment for that convention), justified here because this is
// test tooling, not a deployed service, and byte-for-byte parity with what
// ingestion actually writes matters more than duplication would buy.
import argon2 from "argon2";
import pg from "pg";
import { writeLatestPositions } from "../../ingestion/src/db/redis.js";
import type { EnrichedStateVector } from "../../ingestion/src/enrichment/attachRoutes.js";
import {
  SEEDED_AIRCRAFT_ICAO24,
  SEEDED_AIRCRAFT_CALLSIGN,
  SEEDED_AIRCRAFT_REGISTRATION,
  SEEDED_AIRCRAFT_MODEL,
  SEEDED_LOGIN_EMAIL,
  SEEDED_LOGIN_PASSWORD,
  PUGET_SOUND_CENTER,
} from "./constants.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://pugetscope:pugetscope@localhost:5433/pugetscope";

async function seedPostgres(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    // Idempotent (ON CONFLICT ...) so re-running against a docker-compose
    // Postgres that already has data from a previous local e2e run (its
    // volume persists across `docker compose down`/`up`, unlike Redis's
    // ephemeral container) never fails on a duplicate key.
    await client.query(
      `INSERT INTO aircraft (icao24, registration, manufacturer, model, typecode, operator)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (icao24) DO UPDATE SET
         registration = EXCLUDED.registration, manufacturer = EXCLUDED.manufacturer,
         model = EXCLUDED.model, typecode = EXCLUDED.typecode, operator = EXCLUDED.operator`,
      [SEEDED_AIRCRAFT_ICAO24, SEEDED_AIRCRAFT_REGISTRATION, "Boeing", SEEDED_AIRCRAFT_MODEL, "B738", "PugetScope E2E"],
    );

    const passwordHash = await argon2.hash(SEEDED_LOGIN_PASSWORD);
    await client.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [SEEDED_LOGIN_EMAIL, passwordHash],
    );
  } finally {
    await client.end();
  }
}

async function seedRedis(): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  // Placed exactly at the map's default center (frontend/src/lib/config.ts)
  // so it's guaranteed on-screen (and therefore clickable) on initial load,
  // without a spec needing to pan/zoom first.
  const [lon, lat] = PUGET_SOUND_CENTER;
  const state: EnrichedStateVector = {
    icao24: SEEDED_AIRCRAFT_ICAO24,
    callsign: SEEDED_AIRCRAFT_CALLSIGN,
    originCountry: "United States",
    timePosition: nowSeconds,
    lastContact: nowSeconds,
    longitude: lon,
    latitude: lat,
    baroAltitude: 1500,
    onGround: false,
    velocity: 90,
    trueTrack: 270,
    verticalRate: 0,
    geoAltitude: 1500,
    squawk: null,
    spi: false,
    category: null,
  };
  await writeLatestPositions([state]);
}

async function main(): Promise<void> {
  await seedPostgres();
  await seedRedis();
  console.log("[e2e] seed complete");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[e2e] seed failed:", err);
    process.exit(1);
  });
