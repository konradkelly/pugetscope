import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { redis } from "../db/redis.js";

let app: FastifyInstance;
let xff = 0;
// A fresh X-Forwarded-For per call gives each request its own rate-limit
// bucket (api/src/index.ts's trustProxy: true + per-route overrides on
// /auth/forgot-password and /auth/reset-password) — see docs in the testing
// plan on why this suite would otherwise risk unrelated 429s.
function headers() {
  xff += 1;
  return { "x-forwarded-for": `10.0.0.${xff}` };
}

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

async function signup(email: string, password: string) {
  return app.inject({ method: "POST", url: "/auth/signup", headers: headers(), payload: { email, password } });
}

describe("POST /auth/signup", () => {
  it("creates a user, returns 201, and sets a session cookie", async () => {
    const res = await signup("new@example.com", "password123");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: "new@example.com" });
    const cookie = res.cookies.find((c) => c.name === "pugetscope_session");
    expect(cookie).toBeDefined();
    expect(cookie!.httpOnly).toBe(true);
  });

  it("rejects an invalid email", async () => {
    const res = await signup("not-an-email", "password123");
    expect(res.statusCode).toBe(400);
  });

  it("rejects a too-short password", async () => {
    const res = await signup("short@example.com", "abc123");
    expect(res.statusCode).toBe(400);
  });

  it("rejects a duplicate email with 409", async () => {
    await signup("dupe@example.com", "password123");
    const res = await signup("dupe@example.com", "password123");
    expect(res.statusCode).toBe(409);
  });
});

describe("POST /auth/login", () => {
  it("logs in with correct credentials and sets a session cookie", async () => {
    await signup("login@example.com", "password123");
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: headers(),
      payload: { email: "login@example.com", password: "password123" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((c) => c.name === "pugetscope_session")).toBeDefined();
  });

  it("rejects the wrong password with 401", async () => {
    await signup("wrongpw@example.com", "password123");
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: headers(),
      payload: { email: "wrongpw@example.com", password: "nope12345" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a nonexistent email with the same 401 shape (no enumeration)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: headers(),
      payload: { email: "nobody@example.com", password: "whatever1" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid email or password" });
  });
});

describe("GET /auth/me and session lifecycle", () => {
  it("returns the current user when a valid session cookie is sent", async () => {
    const signupRes = await signup("me@example.com", "password123");
    const cookie = signupRes.cookies.find((c) => c.name === "pugetscope_session")!;

    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email: "me@example.com" });
  });

  it("returns 401 with no session cookie", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/me" });
    expect(res.statusCode).toBe(401);
  });

  it("logout destroys the session so a subsequent /auth/me is 401", async () => {
    const signupRes = await signup("logout@example.com", "password123");
    const cookie = signupRes.cookies.find((c) => c.name === "pugetscope_session")!;
    const cookieHeader = `${cookie.name}=${cookie.value}`;

    const logoutRes = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: cookieHeader },
    });
    expect(logoutRes.statusCode).toBe(204);

    const meRes = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: cookieHeader } });
    expect(meRes.statusCode).toBe(401);
  });
});

describe("POST /auth/forgot-password and /auth/reset-password", () => {
  it("issues a working reset token for a real user, without calling real SES (SES_FROM_EMAIL unset)", async () => {
    await signup("reset@example.com", "password123");

    const forgotRes = await app.inject({
      method: "POST",
      url: "/auth/forgot-password",
      headers: headers(),
      payload: { email: "reset@example.com" },
    });
    expect(forgotRes.statusCode).toBe(200);
    expect(forgotRes.json()).toEqual({ ok: true });

    // No API surface returns the raw token (by design) — read it directly
    // from Redis, the same store createResetToken/consumeResetToken use.
    const keys = await redis.keys("password-reset:*");
    expect(keys).toHaveLength(1);
    const token = keys[0].replace("password-reset:", "");

    const resetRes = await app.inject({
      method: "POST",
      url: "/auth/reset-password",
      headers: headers(),
      payload: { token, password: "newpassword456" },
    });
    expect(resetRes.statusCode).toBe(200);
    expect(resetRes.cookies.find((c) => c.name === "pugetscope_session")).toBeDefined();

    // Old password no longer works; new one does.
    const oldLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: headers(),
      payload: { email: "reset@example.com", password: "password123" },
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: headers(),
      payload: { email: "reset@example.com", password: "newpassword456" },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it("does not reveal whether an email is registered (always 200 ok:true)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/forgot-password",
      headers: headers(),
      payload: { email: "never-signed-up@example.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    // And, unlike the real-user case above, no token should have been issued.
    const keys = await redis.keys("password-reset:*");
    expect(keys).toHaveLength(0);
  });

  it("rejects an invalid/unknown reset token with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/reset-password",
      headers: headers(),
      payload: { token: "not-a-real-token", password: "newpassword456" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("a reset token can only be used once", async () => {
    await signup("onceonly@example.com", "password123");
    await app.inject({
      method: "POST",
      url: "/auth/forgot-password",
      headers: headers(),
      payload: { email: "onceonly@example.com" },
    });
    const keys = await redis.keys("password-reset:*");
    const token = keys[0].replace("password-reset:", "");

    const first = await app.inject({
      method: "POST",
      url: "/auth/reset-password",
      headers: headers(),
      payload: { token, password: "firstreset1" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/auth/reset-password",
      headers: headers(),
      payload: { token, password: "secondreset2" },
    });
    expect(second.statusCode).toBe(400);
  });
});
