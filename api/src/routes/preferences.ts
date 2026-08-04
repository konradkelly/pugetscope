import type { FastifyInstance } from "fastify";
import { pool } from "../db/postgres.js";
import { getCurrentUserId } from "../auth/session.js";

const MAP_VIEW_KEY = "mapView";
const MIN_ZOOM = 0;
const MAX_ZOOM = 24;

interface MapView {
  lat: number;
  lng: number;
  zoom: number;
}

interface PreferenceRow {
  value: string;
}

function isValidMapView(body: unknown): body is MapView {
  const { lat, lng, zoom } = (body ?? {}) as Partial<MapView>;
  return (
    typeof lat === "number" &&
    Number.isFinite(lat) &&
    Math.abs(lat) <= 90 &&
    typeof lng === "number" &&
    Number.isFinite(lng) &&
    Math.abs(lng) <= 180 &&
    typeof zoom === "number" &&
    Number.isFinite(zoom) &&
    zoom >= MIN_ZOOM &&
    zoom <= MAX_ZOOM
  );
}

export async function preferencesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/preferences/map-view", async (request, reply) => {
    const userId = await getCurrentUserId(request);
    if (!userId) return reply.code(401).send({ error: "log in to save a map view" });

    const result = await pool.query<PreferenceRow>(
      "SELECT value FROM user_preferences WHERE user_id = $1 AND key = $2",
      [userId, MAP_VIEW_KEY],
    );

    const raw = result.rows[0]?.value;
    if (!raw) return reply.send({ view: null });

    try {
      return reply.send({ view: JSON.parse(raw) as MapView });
    } catch {
      // A corrupt/legacy value shouldn't break the map — just treat it as unset.
      return reply.send({ view: null });
    }
  });

  app.put<{ Body: Partial<MapView> }>("/preferences/map-view", async (request, reply) => {
    const userId = await getCurrentUserId(request);
    if (!userId) return reply.code(401).send({ error: "log in to save a map view" });

    if (!isValidMapView(request.body)) {
      return reply.code(400).send({
        error: `lat/lng must be valid coordinates and zoom must be between ${MIN_ZOOM} and ${MAX_ZOOM}`,
      });
    }
    const { lat, lng, zoom } = request.body as MapView;

    await pool.query(
      `INSERT INTO user_preferences (user_id, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [userId, MAP_VIEW_KEY, JSON.stringify({ lat, lng, zoom })],
    );

    return reply.code(204).send();
  });
}
