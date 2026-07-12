import { Redis } from "ioredis";
import { config } from "../config.js";

// Two separate connections: once a client issues SUBSCRIBE it can't run
// other commands, so the snapshot reads (SCAN/MGET) need their own client.
export const redis = new Redis(config.redisUrl);
export const subscriber = new Redis(config.redisUrl);

export async function getSnapshot(): Promise<unknown[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, batch] = await redis.scan(
      cursor,
      "MATCH",
      "aircraft:latest:*",
      "COUNT",
      100,
    );
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== "0");

  if (keys.length === 0) return [];
  const values = await redis.mget(...keys);
  return values.filter((v): v is string => v !== null).map((v) => JSON.parse(v));
}
