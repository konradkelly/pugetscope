import type { FastifyInstance } from "fastify";
import { pool } from "../db/postgres.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ICAO24_OR_CALLSIGN_RE = /^[A-Za-z0-9]{1,8}$/;

// Guards against a single device papering the table with watches — this is
// an anonymous, unauthenticated surface (see docs/SPEC.md), so the only
// abuse control available is a hard per-device cap plus the per-route rate
// limits below.
const MAX_WATCHES_PER_DEVICE = 10;
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

      await pool.query(
        `INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (device_id) DO UPDATE
           SET endpoint = EXCLUDED.endpoint, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
        [deviceId, endpoint, p256dh, auth],
      );

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

      const count = await pool.query<{ count: string }>(
        "SELECT count(*) FROM alert_watches WHERE device_id = $1",
        [body.deviceId],
      );
      if (Number(count.rows[0].count) >= MAX_WATCHES_PER_DEVICE) {
        return reply.code(409).send({ error: `at most ${MAX_WATCHES_PER_DEVICE} watches per device` });
      }

      const label = body.label?.slice(0, 100) ?? null;

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
          `INSERT INTO alert_watches (device_id, kind, label, location, radius_m, max_altitude_m)
           VALUES ($1, 'geofence', $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6)
           RETURNING id::int`,
          [body.deviceId, label, lon, lat, Math.round(radiusM), maxAltitudeM ?? null],
        );
        return reply.code(201).send({ id: inserted.rows[0].id });
      }

      if (body.kind === "callsign") {
        const matchValue = body.matchValue?.trim().toUpperCase();
        if (!matchValue || !ICAO24_OR_CALLSIGN_RE.test(matchValue)) {
          return reply.code(400).send({ error: "matchValue must be a callsign or icao24 hex code" });
        }

        const inserted = await pool.query<{ id: number }>(
          `INSERT INTO alert_watches (device_id, kind, label, match_value)
           VALUES ($1, 'callsign', $2, $3)
           RETURNING id::int`,
          [body.deviceId, label, matchValue],
        );
        return reply.code(201).send({ id: inserted.rows[0].id });
      }

      return reply.code(400).send({ error: "kind must be 'geofence' or 'callsign'" });
    },
  );

  app.get<{ Querystring: { deviceId?: string } }>("/alerts/watches", async (request, reply) => {
    const { deviceId } = request.query;
    if (!isValidDeviceId(deviceId)) {
      return reply.code(400).send({ error: "deviceId must be a UUID" });
    }

    const result = await pool.query<WatchRow>(
      `SELECT id::int, kind, label,
              ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon,
              radius_m, max_altitude_m, match_value, created_at
       FROM alert_watches
       WHERE device_id = $1
       ORDER BY created_at DESC`,
      [deviceId],
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
        createdAt: r.created_at,
      })),
    });
  });

  app.delete<{ Params: { id: string }; Querystring: { deviceId?: string } }>(
    "/alerts/watches/:id",
    async (request, reply) => {
      const { deviceId } = request.query;
      if (!isValidDeviceId(deviceId)) {
        return reply.code(400).send({ error: "deviceId must be a UUID" });
      }

      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid watch id" });
      }

      const result = await pool.query("DELETE FROM alert_watches WHERE id = $1 AND device_id = $2", [
        id,
        deviceId,
      ]);

      if (result.rowCount === 0) {
        return reply.code(404).send({ error: "watch not found" });
      }

      return reply.code(204).send();
    },
  );
}
