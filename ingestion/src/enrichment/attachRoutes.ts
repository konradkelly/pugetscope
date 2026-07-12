import type { StateVector } from "../openskyClient.js";
import type { Airport, FlightRoute } from "./adsbdbClient.js";
import { getFreshRoutes } from "../db/flightRoutes.js";
import { enqueueLookup } from "./routeLookupWorker.js";
import { getRegionalAirport, inferFlightPhase, type FlightPhase } from "./regionalAirports.js";
import { findFidsMatches, type FidsMatch } from "../db/fidsFlights.js";

// "typical" = adsbdb's crowd-sourced route, unverified against this specific
// flight. "inferred" = we directly observed this aircraft landing at /
// departing from a regional airport (own-track inference — tier 2 of
// docs/SPEC.md §12); only the in-region endpoint is known this way, the
// other stays null unless corroborated separately. "live" = a real FIDS
// board match (tier 1) — authoritative origin/destination, and for an
// arrival, a real estimated/actual arrival time (eta).
export type RouteConfidence = "live" | "inferred" | "typical";
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
 * a real estimated/actual arrival time, surfaced as eta. */
function buildFidsRoute(match: FidsMatch): EnrichedRoute {
  const homeRegional = getRegionalAirport(match.homeIcao);
  const home: Airport = homeRegional
    ? { icao: homeRegional.icao, iata: homeRegional.iata, name: homeRegional.name, lat: homeRegional.lat, lon: homeRegional.lon }
    : { icao: match.homeIcao, iata: null, name: null, lat: null, lon: null };
  const other = airportFromFids(match.other);
  return {
    origin: match.direction === "departure" ? home : other,
    destination: match.direction === "arrival" ? home : other,
    airline: match.airlineName,
    confidence: "live",
    eta:
      match.direction === "arrival" && match.revisedTime
        ? match.revisedTime.toISOString()
        : undefined,
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
 * A cached route is "contradicted" when we can directly observe (via
 * inferFlightPhase) that this aircraft is landing at or departing from a
 * regional airport other than what the route claims. E.g. adsbdb says
 * PDX->JFK but the aircraft is visibly descending into SEA right now — the
 * cached route describes what this callsign *usually* flies, not this leg.
 */
function isContradicted(phase: NonNullable<FlightPhase>, route: FlightRoute): boolean {
  const claimedIcao =
    phase.kind === "landing" ? route.destination?.icao : route.origin?.icao;
  if (!claimedIcao) return false; // route doesn't even claim an airport here
  return claimedIcao.toUpperCase() !== phase.airportIcao;
}

/**
 * Attaches route info to each state, resolving tiers highest-confidence
 * first (docs/SPEC.md §12):
 *  1. FIDS board match (real schedule data) -> "live", used as-is.
 *  2. Otherwise, adsbdb cache: a hit not contradicted by direct observation
 *     -> "typical"; missing/stale/contradicted -> fall through.
 *  3. Own-track inference (landing/departing near a regional airport) ->
 *     "inferred" partial route as the final fallback when 1-2 don't apply.
 * The external adsbdb API is never called from this path — misses/stale
 * entries just get enqueued for a background lookup.
 */
export async function attachRoutes(states: StateVector[]): Promise<EnrichedStateVector[]> {
  const callsigns = [
    ...new Set(states.map((s) => s.callsign).filter((c): c is string => !!c)),
  ];
  const [cachedRoutes, fidsMatches] = await Promise.all([
    getFreshRoutes(callsigns),
    findFidsMatches(callsigns),
  ]);

  return states.map((s) => {
    const phase = inferFlightPhase(s);
    const inferredFallback = phase ? { ...s, route: buildInferredRoute(phase) } : s;

    if (!s.callsign) return inferredFallback;

    const fidsMatch = fidsMatches.get(s.callsign);
    if (fidsMatch) return { ...s, route: buildFidsRoute(fidsMatch) };

    const hit = cachedRoutes.get(s.callsign);
    if (!hit) {
      enqueueLookup(s.callsign); // missing or stale — refresh in the background
      return inferredFallback;
    }

    // found === false is a fresh negative-cache hit: known to have no route.
    if (!hit.found || !hit.route) return inferredFallback;

    if (phase && isContradicted(phase, hit.route)) return inferredFallback;

    return { ...s, route: { ...hit.route, confidence: "typical" } };
  });
}
