import type { StateVector } from "../openskyClient.js";
import { getRegionalAirport, inferFlightPhase, type FlightPhase } from "./regionalAirports.js";
import { findFidsMatches, type FidsMatch } from "../db/fidsFlights.js";

export interface Airport {
  icao: string | null;
  iata: string | null;
  name: string | null;
  lat: number | null;
  lon: number | null;
}

export interface FlightRoute {
  origin: Airport | null;
  destination: Airport | null;
  airline: string | null;
}

// "inferred" = we directly observed this aircraft landing at / departing
// from a regional airport (own-track inference — tier 2 of docs/SPEC.md
// §12, the final fallback); only the in-region endpoint is known this way,
// the other stays null unless corroborated separately. "live" = a real FIDS
// board match (tier 1) — authoritative origin/destination, and for an
// arrival, a real estimated/actual arrival time (eta).
export type RouteConfidence = "live" | "inferred";
export type EnrichedRoute = FlightRoute & {
  confidence: RouteConfidence;
  eta?: string; // ISO UTC — only populated by a "live" arrival match
};
export type EnrichedStateVector = StateVector & { route?: EnrichedRoute };

function airportFromPhase(phase: NonNullable<FlightPhase>): Airport | null {
  const airport = getRegionalAirport(phase.airportIcao);
  if (!airport) return null;
  return { icao: airport.icao, iata: airport.iata, name: airport.name, lat: airport.lat, lon: airport.lon };
}

function airportFromFids(a: FidsMatch["other"]): Airport {
  return { icao: a.icao, iata: a.iata, name: a.name, lat: a.lat, lon: a.lon };
}

/** Builds an authoritative route from a FIDS board match — tier 1 of
 * docs/SPEC.md §12. A "departure" row means this airport is the origin; an
 * "arrival" row means it's the destination, and revisedTime (if present) is
 * a real estimated/actual arrival time, surfaced as eta — but only while the
 * flight is still en route. Once it has arrived (live onGround flag, or the
 * board's own "Arrived" status) the ETA is dropped rather than left showing
 * a now-past time for a plane already taxiing at the gate. onGround is the
 * primary signal since it's live (30s) vs the ~30-min FIDS board. */
function buildFidsRoute(match: FidsMatch, onGround: boolean): EnrichedRoute {
  const homeRegional = getRegionalAirport(match.homeIcao);
  const home: Airport = homeRegional
    ? { icao: homeRegional.icao, iata: homeRegional.iata, name: homeRegional.name, lat: homeRegional.lat, lon: homeRegional.lon }
    : { icao: match.homeIcao, iata: null, name: null, lat: null, lon: null };
  const other = airportFromFids(match.other);

  // Backstop for the touchdown->taxi window: onGround can lag by a poll or two
  // after landing, so also treat an ETA more than 10 min in the past as
  // arrived. 10 min is generous enough not to hide an about-to-land flight
  // whose estimate merely slipped (those correctly show "any moment").
  const etaStale =
    !!match.revisedTime && match.revisedTime.getTime() < Date.now() - 10 * 60 * 1000;
  const arrived = onGround || match.status === "Arrived" || etaStale;
  const showEta = match.direction === "arrival" && !!match.revisedTime && !arrived;

  return {
    origin: match.direction === "departure" ? home : other,
    destination: match.direction === "arrival" ? home : other,
    airline: match.airlineName,
    confidence: "live",
    eta: showEta ? match.revisedTime!.toISOString() : undefined,
  };
}

/** Builds a partial route from direct observation alone — only the endpoint
 * we can see (this aircraft is landing/departing here right now) is filled
 * in; the far endpoint is unknown until/unless a route lookup corroborates
 * it. See docs/SPEC.md §12 "Routing accuracy upgrade" tier 2. */
function buildInferredRoute(phase: NonNullable<FlightPhase>): EnrichedRoute {
  const airport = airportFromPhase(phase);
  return {
    origin: phase.kind === "departing" ? airport : null,
    destination: phase.kind === "landing" ? airport : null,
    airline: null,
    confidence: "inferred",
  };
}

/**
 * Attaches route info to each state, resolving tiers highest-confidence
 * first (docs/SPEC.md §12):
 *  1. FIDS board match (real schedule data, all 5 regional airports) -> "live", used as-is.
 *  2. Own-track inference (landing/departing near a regional airport) ->
 *     "inferred" partial route as the final fallback when there's no FIDS match.
 */
export async function attachRoutes(states: StateVector[]): Promise<EnrichedStateVector[]> {
  const callsigns = [
    ...new Set(states.map((s) => s.callsign).filter((c): c is string => !!c)),
  ];
  const fidsMatches = await findFidsMatches(callsigns);

  return states.map((s) => {
    const phase = inferFlightPhase(s);
    const inferredFallback = phase ? { ...s, route: buildInferredRoute(phase) } : s;

    if (!s.callsign) return inferredFallback;

    const fidsMatch = fidsMatches.get(s.callsign);
    if (fidsMatch) return { ...s, route: buildFidsRoute(fidsMatch, s.onGround) };

    return inferredFallback;
  });
}
