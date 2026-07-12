import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { redis } from "../db/redis.js";
import { config } from "../config.js";

function sessionKey(token: string): string {
  return `session:${token}`;
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await redis.set(sessionKey(token), userId, "EX", config.session.ttlSeconds);
  return token;
}

export async function getSessionUserId(token: string): Promise<string | null> {
  return redis.get(sessionKey(token));
}

export async function destroySession(token: string): Promise<void> {
  await redis.del(sessionKey(token));
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(config.session.cookieName, token, {
    httpOnly: true,
    secure: config.session.secureCookie,
    sameSite: "lax",
    path: "/",
    maxAge: config.session.ttlSeconds,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(config.session.cookieName, { path: "/" });
}

export async function getCurrentUserId(request: FastifyRequest): Promise<string | null> {
  const token = request.cookies[config.session.cookieName];
  if (!token) return null;
  return getSessionUserId(token);
}
