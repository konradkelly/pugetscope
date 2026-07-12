import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { createUser, findUserByEmail, findUserById } from "../auth/users.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  getCurrentUserId,
  setSessionCookie,
} from "../auth/session.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { email?: string; password?: string } }>(
    "/auth/signup",
    async (request, reply) => {
      const { email, password } = request.body ?? {};
      if (!email || !EMAIL_RE.test(email)) {
        return reply.code(400).send({ error: "valid email required" });
      }
      if (!password || password.length < 8) {
        return reply.code(400).send({ error: "password must be at least 8 characters" });
      }

      const existing = await findUserByEmail(email);
      if (existing) {
        return reply.code(409).send({ error: "email already registered" });
      }

      const passwordHash = await hashPassword(password);
      const user = await createUser(email, passwordHash);
      const token = await createSession(user.id);
      setSessionCookie(reply, token);
      return reply.code(201).send({ id: user.id, email: user.email });
    },
  );

  app.post<{ Body: { email?: string; password?: string } }>(
    "/auth/login",
    async (request, reply) => {
      const { email, password } = request.body ?? {};
      if (!email || !password) {
        return reply.code(400).send({ error: "email and password required" });
      }

      const user = await findUserByEmail(email);
      // constant-shape response whether the user exists or not, to avoid
      // leaking which emails are registered via response timing/content
      const valid = user ? await verifyPassword(user.passwordHash, password) : false;
      if (!user || !valid) {
        return reply.code(401).send({ error: "invalid email or password" });
      }

      const token = await createSession(user.id);
      setSessionCookie(reply, token);
      return reply.send({ id: user.id, email: user.email });
    },
  );

  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[config.session.cookieName];
    if (token) await destroySession(token);
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get("/auth/me", async (request, reply) => {
    const userId = await getCurrentUserId(request);
    if (!userId) return reply.code(401).send({ error: "not authenticated" });

    const user = await findUserById(userId);
    if (!user) return reply.code(401).send({ error: "not authenticated" });

    return reply.send(user);
  });
}
