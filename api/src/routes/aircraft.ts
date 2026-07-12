import type { FastifyInstance } from "fastify";
import { redis } from "../db/redis.js";
import { pool } from "../db/postgres.js";

async function scanKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

export async function aircraftRoutes(app: FastifyInstance): Promise<void> {
  app.get("/aircraft", async (_request, reply) => {
    const keys = await scanKeys("aircraft:latest:*");
    if (keys.length === 0) return reply.send([]);

    const values = await redis.mget(...keys);
    const aircraft = values
      .filter((v): v is string => v !== null)
      .map((v) => JSON.parse(v));
    return reply.send(aircraft);
  });

  app.get<{ Params: { icao24: string } }>("/aircraft/:icao24", async (request, reply) => {
    const { icao24 } = request.params;

    const [latestRaw, referenceResult] = await Promise.all([
      redis.get(`aircraft:latest:${icao24}`),
      pool.query(
        `SELECT icao24, registration, manufacturer, model, typecode, operator, first_seen, last_seen
         FROM aircraft WHERE icao24 = $1`,
        [icao24],
      ),
    ]);

    const reference = referenceResult.rows[0] ?? null;
    if (!latestRaw && !reference) {
      return reply.code(404).send({ error: "aircraft not found" });
    }

    return reply.send({
      ...reference,
      latest: latestRaw ? JSON.parse(latestRaw) : null,
    });
  });
}
