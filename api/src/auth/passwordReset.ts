import { randomBytes } from "node:crypto";
import { redis } from "../db/redis.js";

// Same shape as session.ts's createSession/getSessionUserId — a random
// token in Redis mapping to a userId, TTL-bounded — just a shorter TTL and
// single-use (consumeResetToken deletes on read) since this represents a
// one-time "prove you own this inbox" action, not an ongoing login.
const RESET_TOKEN_TTL_SECONDS = 30 * 60; // 30 minutes

function resetKey(token: string): string {
  return `password-reset:${token}`;
}

export async function createResetToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await redis.set(resetKey(token), userId, "EX", RESET_TOKEN_TTL_SECONDS);
  return token;
}

// Deletes the token as part of reading it, so a given reset link can only
// ever be used once — a second attempt (or a replay) gets null, same as an
// already-expired one.
export async function consumeResetToken(token: string): Promise<string | null> {
  const key = resetKey(token);
  const userId = await redis.get(key);
  if (!userId) return null;
  await redis.del(key);
  return userId;
}
