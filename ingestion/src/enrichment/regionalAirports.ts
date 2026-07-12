import type { StateVector } from "../openskyClient.js";

// Puget Sound regional airports — see docs/SPEC.md §1/§3. Coordinates are
// airport reference points (approximate, sufficient for the ~15km proximity
// check below — not landing-accuracy geodesy).
export const REGIONAL_AIRPORTS = [
  { icao: "KSEA", name: "Seattle-Tacoma Intl", lat: 47.4502, lon: -122.3088 },
  { icao: "KBFI", name: "Boeing Field", lat: 47.53, lon: -122.3019 },
  { icao: "KPAE", name: "Paine Field", lat: 47.9063, lon: -122.2816 },
  { icao: "KRNT", name: "Renton Municipal", lat: 47.4931, lon: -122.216 },
  { icao: "KTIW", name: "Tacoma Narrows", lat: 47.2679, lon: -122.5776 },
] as const;

const EARTH_RADIUS_KM = 6371;

export function haversineKm(
  lat1: number, lon1: number, lat2: number, lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const PROXIMITY_KM = 15;

export function nearestRegionalAirport(
  lat: number, lon: number,
): { icao: string; distanceKm: number } | null {
  let best: { icao: string; distanceKm: number } | null = null;
  for (const airport of REGIONAL_AIRPORTS) {
    const distanceKm = haversineKm(lat, lon, airport.lat, airport.lon);
    if (distanceKm <= PROXIMITY_KM && (!best || distanceKm < best.distanceKm)) {
      best = { icao: airport.icao, distanceKm };
    }
  }
  return best;
}

// Heuristics, not ground-truth: no runway/terrain data, so "near the ground"
// is an absolute altitude threshold rather than height-above-ground. Fine at
// Puget Sound's near-sea-level elevations; would need real AGL for airports
// at meaningful elevation.
const NEAR_GROUND_ALTITUDE_M = 600;
const CLIMB_DESCENT_THRESHOLD_MS = 1;

export type FlightPhase = { kind: "landing" | "departing"; airportIcao: string } | null;

/**
 * Infers whether a state vector looks like it's landing at or departing from
 * a nearby regional airport, purely from geometry + vertical rate — no
 * external data. Used to sanity-check (not replace) the crowd-sourced route
 * lookup. See docs/SPEC.md §12 "Routing accuracy upgrade" tier 2.
 */
export function inferFlightPhase(state: StateVector): FlightPhase {
  if (state.onGround || state.latitude === null || state.longitude === null) return null;

  const altitude = state.geoAltitude ?? state.baroAltitude;
  if (altitude === null || altitude > NEAR_GROUND_ALTITUDE_M) return null;

  const nearest = nearestRegionalAirport(state.latitude, state.longitude);
  if (!nearest) return null;

  const verticalRate = state.verticalRate ?? 0;
  if (verticalRate <= -CLIMB_DESCENT_THRESHOLD_MS) {
    return { kind: "landing", airportIcao: nearest.icao };
  }
  if (verticalRate >= CLIMB_DESCENT_THRESHOLD_MS) {
    return { kind: "departing", airportIcao: nearest.icao };
  }
  return null; // near the ground but level — ambiguous (could be low overflight)
}
