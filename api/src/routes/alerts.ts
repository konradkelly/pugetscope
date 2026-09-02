import type { FastifyInstance } from "fastify";
import { pool } from "../db/postgres.js";
import { getCurrentUserId } from "../auth/session.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ICAO24_OR_CALLSIGN_RE = /^[A-Za-z0-9]{1,8}$/;

// Guards against a single device (or, for a logged-in caller, a single
// account) papering the table with watches. This surface stays usable with
// no account at all (see docs/SPEC.md) — device_id is the only "auth" an
// anonymous caller has, hence the lower cap; a logged-in account is a
// weaker abuse vector than a bare client-generated UUID, hence the higher one.
const MAX_WATCHES_PER_DEVICE = 10;
const MAX_WATCHES_PER_USER = 25;
const MIN_RADIUS_M = 100;
const MAX_RADIUS_M = 50_000;

interface SubscribeBody {
  deviceId?: string;
  subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
}

interface CreateWatchBody {
  deviceId?: string;
  kind?: "geofence" | "callsign";
  label?: string;
  lat?: number;
  lon?: number;
  radiusM?: number;
  maxAltitudeM?: number;
  matchValue?: string;
  notifyEmail?: boolean;
}

interface WatchRow {
  id: number;
  kind: "geofence" | "callsign";
  label: string | null;
  lat: number | null;
  lon: number | null;
  radius_m: number | null;
  max_altitude_m: number | null;
  match_value: string | null;
  notify_email: boolean;
  created_at: string;
}

function isValidDeviceId(deviceId: unknown): deviceId is string {
  return typeof deviceId === "string" && UUID_RE.test(deviceId);
}

export async function alertsRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: SubscribeBody }>(
    "/alerts/subscribe",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { deviceId, subscription } = request.body ?? {};
      if (!isValidDeviceId(deviceId)) {
        return reply.code(400).send({ error: "deviceId must be a UUID" });
      }
      const endpoint = subscription?.endpoint;
      const p256dh = subscription?.keys?.p256dh;
      const auth = subscription?.keys?.auth;
      if (!endpoint || !p256dh || !auth) {
        return reply.code(400).send({ error: "subscription must include endpoint and keys.p256dh/auth" });
      }

      // Optional — this route works exactly as before when logged out. When
      // logged in, tag the subscription with the account (without clobbering
      // an existing tag on a re-subscribe from an unauthenticated context)
      // and backfill any of this device's pre-existing anonymous watches, so
      // login on an already-in-use device links its history immediately
      // rather than only going forward.
      const userId = await getCurrentUserId(request);

      await pool.query(
        `INSERT INTO push_subscriptions (device_id, user_id, endpoint, p256dh, auth)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (device_id) DO UPDATE
           SET user_id = COALESCE(EXCLUDED.user_id, push_subscriptions.user_id),
               endpoint = EXCLUDED.endpoint, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
        [deviceId, userId, endpoint, p256dh, auth],
      );

      if (userId) {
        await pool.query(
          `UPDATE alert_watches SET user_id = $1 WHERE device_id = $2 AND user_id IS NULL`,
          [userId, deviceId],
        );
      }

      return reply.code(204).send();
    },
  );

  app.post<{ Body: CreateWatchBody }>(
    "/alerts/watches",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = request.body ?? {};
      if (!isValidDeviceId(body.deviceId)) {
        return reply.code(400).send({ error: "deviceId must be a UUID" });
      }

      const subscribed = await pool.query("SELECT 1 FROM push_subscriptions WHERE device_id = $1", [
        body.deviceId,
      ]);
      if (subscribed.rowCount === 0) {
        return reply.code(404).send({ error: "no push subscription for this device — call /alerts/subscribe first" });
      }

      const userId = await getCurrentUserId(request);

      const count = userId
        ? await pool.query<{ count: string }>("SELECT count(*) FROM alert_watches WHERE user_id = $1", [
            userId,
          ])
        : await pool.query<{ count: string }>("SELECT count(*) FROM alert_watches WHERE device_id = $1", [
            body.deviceId,
          ]);
      const limit = userId ? MAX_WATCHES_PER_USER : MAX_WATCHES_PER_DEVICE;
      if (Number(count.rows[0].count) >= limit) {
        return reply.code(409).send({ error: `at most ${limit} watches per ${userId ? "account" : "device"}` });
      }

      const label = body.label?.slice(0, 100) ?? null;
      // Email opt-in requires an account — an anonymous device watch has no
      // email address to send to (see notify_email's column comment in
      // db/init/001_schema.sql) — so silently ignore the flag rather than
      // erroring when logged out.
      const notifyEmail = Boolean(userId) && body.notifyEmail === true;

      if (body.kind === "geofence") {
        const { lat, lon, radiusM, maxAltitudeM } = body;
        if (typeof lat !== "number" || typeof lon !== "number" || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          return reply.code(400).send({ error: "lat/lon must be valid coordinates" });
        }
        if (typeof radiusM !== "number" || radiusM < MIN_RADIUS_M || radiusM > MAX_RADIUS_M) {
          return reply.code(400).send({ error: `radiusM must be between ${MIN_RADIUS_M} and ${MAX_RADIUS_M}` });
        }
        if (maxAltitudeM !== undefined && (typeof maxAltitudeM !== "number" || maxAltitudeM < 0)) {
          return reply.code(400).send({ error: "maxAltitudeM must be a non-negative number" });
        }

        const inserted = await pool.query<{ id: number }>(
          `INSERT INTO alert_watches (device_id, user_id, kind, label, location, radius_m, max_altitude_m, notify_email)
           VALUES ($1, $2, 'geofence', $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6, $7, $8)
           RETURNING id::int`,
          [body.deviceId, userId, label, lon, lat, Math.round(radiusM), maxAltitudeM ?? null, notifyEmail],
        );
        return reply.code(201).send({ id: inserted.rows[0].id });
      }

      if (body.kind === "callsign") {
        const matchValue = body.matchValue?.trim().toUpperCase();
        if (!matchValue || !ICAO24_OR_CALLSIGN_RE.test(matchValue)) {
          return reply.code(400).send({ error: "matchValue must be a callsign or icao24 hex code" });
        }

        const inserted = await pool.query<{ id: number }>(
          `INSERT INTO alert_watches (device_id, user_id, kind, label, match_value, notify_email)
           VALUES ($1, $2, 'callsign', $3, $4, $5)
           RETURNING id::int`,
          [body.deviceId, userId, label, matchValue, notifyEmail],
        );
        return reply.code(201).send({ id: inserted.rows[0].id });
      }

      return reply.code(400).send({ error: "kind must be 'geofence' or 'callsign'" });
    },
  );

  app.get<{ Querystring: { deviceId?: string } }>("/alerts/watches", async (request, reply) => {
    const { deviceId } = request.query;
    const userId = await getCurrentUserId(request);

    // deviceId is only required when there's no session — an authenticated
    // caller may not have deviceId at all (a second device that's never
    // created its own watches), but it's still honored via OR below so a
    // device's pre-existing anonymous watches stay visible right after
    // login even before /alerts/subscribe has backfilled their user_id.
    if (deviceId !== undefined && !isValidDeviceId(deviceId)) {
      return reply.code(400).send({ error: "deviceId must be a UUID" });
    }
    if (!userId && !deviceId) {
      return reply.code(400).send({ error: "deviceId must be a UUID" });
    }

    const result = await pool.query<WatchRow>(
      `SELECT id::int, kind, label,
              ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon,
              radius_m, max_altitude_m, match_value, notify_email, created_at
       FROM alert_watches
       WHERE (($1::uuid IS NOT NULL AND user_id = $1::uuid) OR device_id = $2::uuid)
       ORDER BY created_at DESC`,
      [userId, deviceId ?? null],
    );

    return reply.send({
      watches: result.rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        label: r.label,
        lat: r.lat,
        lon: r.lon,
        radiusM: r.radius_m,
        maxAltitudeM: r.max_altitude_m,
        matchValue: r.match_value,
        notifyEmail: r.notify_email,
        createdAt: r.created_at,
      })),
    });
  });

  app.delete<{ Params: { id: string }; Querystring: { deviceId?: string } }>(
    "/alerts/watches/:id",
    async (request, reply) => {
      const { deviceId } = request.query;
      const userId = await getCurrentUserId(request);

      if (deviceId !== undefined && !isValidDeviceId(deviceId)) {
        return reply.code(400).send({ error: "deviceId must be a UUID" });
      }
      if (!userId && !deviceId) {
        return reply.code(400).send({ error: "deviceId must be a UUID" });
      }

      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid watch id" });
      }

      const result = await pool.query(
        `DELETE FROM alert_watches
         WHERE id = $1 AND (($2::uuid IS NOT NULL AND user_id = $2::uuid) OR device_id = $3::uuid)`,
        [id, userId, deviceId ?? null],
      );

      if (result.rowCount === 0) {
        return reply.code(404).send({ error: "watch not found" });
      }

      return reply.code(204).send();
    },
  );
}
