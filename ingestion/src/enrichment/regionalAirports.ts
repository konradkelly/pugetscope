import type { StateVector } from "../openskyClient.js";

// Puget Sound regional airports — see docs/SPEC.md §1/§3. Coordinates are
// airport reference points (approximate, sufficient for the proximity check
// below — not landing-accuracy geodesy).
//
// `approachRadiusKm` is a per-airport approach-envelope size, NOT one global
// radius. A uniform radius makes small GA fields false attractors: an airliner
// on approach to SEA over Tacoma is momentarily closest to tiny Tacoma Narrows
// (KTIW) and would be wrongly inferred as "landing at TIW" (observed: a
// Southwest 737 at 1105m). So the major field (KSEA) gets a long corridor,
// Boeing-widebody fields a medium one, and small GA fields a tight one that
// only captures genuinely-local low traffic.
export const REGIONAL_AIRPORTS = [
  { icao: "KSEA", iata: "SEA", name: "Seattle-Tacoma Intl", lat: 47.4502, lon: -122.3088, approachRadiusKm: 25 },
  { icao: "KPAE", iata: "PAE", name: "Paine Field", lat: 47.9063, lon: -122.2816, approachRadiusKm: 15 },
  { icao: "KBFI", iata: "BFI", name: "Boeing Field", lat: 47.53, lon: -122.3019, approachRadiusKm: 12 },
  { icao: "KRNT", iata: "RNT", name: "Renton Municipal", lat: 47.4931, lon: -122.216, approachRadiusKm: 8 },
  { icao: "KTIW", iata: "TIW", name: "Tacoma Narrows", lat: 47.2679, lon: -122.5776, approachRadiusKm: 8 },
] as const;

export function getRegionalAirport(icao: string) {
  return REGIONAL_AIRPORTS.find((a) => a.icao === icao);
}

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

export function nearestRegionalAirport(
  lat: number, lon: number,
): { icao: string; distanceKm: number } | null {
  let best: { icao: string; distanceKm: number } | null = null;
  for (const airport of REGIONAL_AIRPORTS) {
    const distanceKm = haversineKm(lat, lon, airport.lat, airport.lon);
    // Each airport uses its own approach-envelope radius (see REGIONAL_AIRPORTS).
    if (distanceKm <= airport.approachRadiusKm && (!best || distanceKm < best.distanceKm)) {
      best = { icao: airport.icao, distanceKm };
    }
  }
  return best;
}

// The altitude gate is distance-aware rather than a flat ceiling, because a
// plane on approach is high when far out and low when near — a flat ceiling
// (previously 600m) only caught aircraft basically over the runway and
// missed the whole approach/departure phase (observed: SWA3051 descending
// into SEA at 808m / ~16km out was above the old 600m gate, so its wrong
// adsbdb "typical" route showed through until it dropped below 600m).
//
// Models a ~3.5°-ish glide/climb path: allowed altitude grows ~60m per km of
// distance from the field, plus a near-field margin for pattern altitude.
// At 3km -> ~480m, at 16km -> ~1260m (catches the SWA3051 case), at the 25km
// edge -> ~1800m. No runway/terrain data, so this is height-above-sea-level;
// fine for Puget Sound's near-sea-level fields, would need real AGL elsewhere.
const APPROACH_ALT_MARGIN_M = 300;
const GLIDESLOPE_M_PER_KM = 60;
const CLIMB_DESCENT_THRESHOLD_MS = 1;

function maxApproachAltitude(distanceKm: number): number {
  return APPROACH_ALT_MARGIN_M + GLIDESLOPE_M_PER_KM * distanceKm;
}

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
  if (altitude === null) return null;

  const nearest = nearestRegionalAirport(state.latitude, state.longitude);
  if (!nearest) return null;

  // Too high for this distance to plausibly be on an approach/departure path
  // to this field — likely just transiting the area.
  if (altitude > maxApproachAltitude(nearest.distanceKm)) return null;

  const verticalRate = state.verticalRate ?? 0;
  if (verticalRate <= -CLIMB_DESCENT_THRESHOLD_MS) {
    return { kind: "landing", airportIcao: nearest.icao };
  }
  if (verticalRate >= CLIMB_DESCENT_THRESHOLD_MS) {
    return { kind: "departing", airportIcao: nearest.icao };
  }
  return null; // in the corridor but level — ambiguous (could be low overflight)
}
