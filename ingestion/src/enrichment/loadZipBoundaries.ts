import { pool } from "../db/postgres.js";
import { config } from "../config.js";

// Census TIGERweb ArcGIS REST service — free, no key, supports server-side
// spatial filtering so this only pulls ZCTAs intersecting our bbox instead of
// the full national ZCTA dataset (hundreds of MB). Layer 2 is "ZIP Code
// Tabulation Areas" under Census2020 — see docs/SPEC.md §13.
const ZCTA_QUERY_URL =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/Census2020/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/2/query";

interface ZctaFeature {
  type: "Feature";
  properties: { ZCTA5?: string };
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: unknown };
}

interface ZctaFeatureCollection {
  type: "FeatureCollection";
  features?: ZctaFeature[];
  error?: { code: number; message: string };
}

async function fetchZctaBoundaries(): Promise<ZctaFeature[]> {
  const { lamin, lomin, lamax, lomax } = config.bbox;
  const params = new URLSearchParams({
    where: "1=1",
    geometry: `${lomin},${lamin},${lomax},${lamax}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "ZCTA5",
    returnGeometry: "true",
    f: "geojson",
  });

  const res = await fetch(`${ZCTA_QUERY_URL}?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`TIGERweb ZCTA query failed: ${res.status}`);
  }

  const body = (await res.json()) as ZctaFeatureCollection;
  if (body.error) {
    throw new Error(`TIGERweb ZCTA query failed: ${body.error.message}`);
  }

  return body.features ?? [];
}

/**
 * One-time (re-runnable) load of zip code boundary polygons covering the
 * Puget Sound bbox, for the noise/overflight-by-neighborhood analytics
 * (docs/SPEC.md §13). Static reference data — geographic boundaries don't
 * change poll-to-poll — so this is a standalone script (`npm run load-zips`),
 * not part of the live ingestion poller.
 */
export async function loadZipBoundaries(): Promise<void> {
  const features = await fetchZctaBoundaries();
  console.log(`[zips] ${features.length} ZCTA boundaries in bbox`);

  let loaded = 0;
  for (const feature of features) {
    const zcta5 = feature.properties.ZCTA5;
    if (!zcta5) continue;

    // ST_Multi normalizes plain Polygon geometries to MultiPolygon so every
    // row matches the column type regardless of which one TIGERweb returned.
    await pool.query(
      `INSERT INTO zip_boundaries (zcta5, boundary)
       VALUES ($1, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))::geography)
       ON CONFLICT (zcta5) DO UPDATE SET boundary = EXCLUDED.boundary`,
      [zcta5, JSON.stringify(feature.geometry)],
    );
    loaded++;
  }

  console.log(`[zips] loaded ${loaded}/${features.length} zip boundaries`);
}
