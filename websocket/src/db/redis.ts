import { Redis } from "ioredis";
import { config } from "../config.js";

// Two separate connections: once a client issues SUBSCRIBE it can't run
// other commands, so the snapshot reads (SCAN/MGET) need their own client.
//
// commandTimeout + keepAlive matter more here than on ingestion's client:
// ingestion issues commands every few seconds so a dead socket gets
// detected and reconnected almost immediately, but `redis` below only runs
// a command when a browser opens /live — it can sit idle for a long time,
// long enough for a silently-dropped connection (e.g. an idle NAT/conntrack
// timeout) to go undetected. Without a timeout, a SCAN/MGET on a socket
// like that just hangs forever instead of erroring and reconnecting.
const clientOptions = { commandTimeout: 5000, keepAlive: 10_000 };
export const redis = new Redis(config.redisUrl, clientOptions);
export const subscriber = new Redis(config.redisUrl, clientOptions);

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
