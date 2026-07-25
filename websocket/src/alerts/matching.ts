import type { CachedWatch } from "./cache.js";

export interface LiveAircraft {
  icao24: string;
  callsign: string | null;
  latitude: number | null;
  longitude: number | null;
  geoAltitude: number | null;
  baroAltitude: number | null;
}

export interface WatchMatch {
  watch: CachedWatch;
  aircraft: LiveAircraft;
}

// Local copy of ingestion/src/enrichment/regionalAirports.ts's haversine —
// not imported directly since there's no shared package between services;
// each is independently deployable by design (docs/SPEC.md §5).
const EARTH_RADIUS_M = 6_371_000;

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Refires no more often than this per watch, so a loitering/circling
// aircraft doesn't send a notification on every ~30s update — mirrors
// spottings' DUPLICATE_COOLDOWN_MINUTES (api/src/routes/spottings.ts).
const COOLDOWN_MS = 30 * 60_000;

export function matchWatches(
  aircraftList: LiveAircraft[],
  watches: CachedWatch[],
  now = Date.now(),
): WatchMatch[] {
  const matches: WatchMatch[] = [];

  for (const watch of watches) {
    if (watch.lastTriggeredAtMs !== null && now - watch.lastTriggeredAtMs < COOLDOWN_MS) continue;

    if (watch.kind === "geofence") {
      if (watch.lat === null || watch.lon === null || watch.radiusM === null) continue;
      const hit = aircraftList.find((ac) => {
        if (ac.latitude === null || ac.longitude === null) return false;
        const altitude = ac.geoAltitude ?? ac.baroAltitude;
        if (watch.maxAltitudeM !== null && (altitude === null || altitude > watch.maxAltitudeM)) return false;
        return haversineMeters(watch.lat!, watch.lon!, ac.latitude, ac.longitude) <= watch.radiusM!;
      });
      if (hit) matches.push({ watch, aircraft: hit });
    } else {
      if (!watch.matchValue) continue;
      const hit = aircraftList.find(
        (ac) =>
          ac.callsign?.trim().toUpperCase() === watch.matchValue ||
          ac.icao24.toUpperCase() === watch.matchValue,
      );
      if (hit) matches.push({ watch, aircraft: hit });
    }
  }

  return matches;
}
