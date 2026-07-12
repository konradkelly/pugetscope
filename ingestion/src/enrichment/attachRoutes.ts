import type { StateVector } from "../openskyClient.js";
import type { Airport, FlightRoute } from "./adsbdbClient.js";
import { getFreshRoutes } from "../db/flightRoutes.js";
import { enqueueLookup } from "./routeLookupWorker.js";
import { getRegionalAirport, inferFlightPhase, type FlightPhase } from "./regionalAirports.js";

// "typical" = adsbdb's crowd-sourced route, unverified against this specific
// flight. "inferred" = we directly observed this aircraft landing at /
// departing from a regional airport (own-track inference — tier 2 of
// docs/SPEC.md §12); only the in-region endpoint is known this way, the
// other stays null unless corroborated separately. "live" is reserved for
// tier 1 (FIDS match) — not built yet.
export type RouteConfidence = "live" | "inferred" | "typical";
export type EnrichedRoute = FlightRoute & { confidence: RouteConfidence };
export type EnrichedStateVector = StateVector & { route?: EnrichedRoute };

function airportFromPhase(phase: NonNullable<FlightPhase>): Airport | null {
  const airport = getRegionalAirport(phase.airportIcao);
  if (!airport) return null;
  return { icao: airport.icao, iata: airport.iata, name: airport.name, lat: airport.lat, lon: airport.lon };
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
 * Attaches route info to each state, preferring direct observation over the
 * crowd-sourced cache wherever they'd disagree:
 *  - no cache entry / stale -> enqueue a background lookup (never call the
 *    external API from this path); meanwhile, if we can directly observe a
 *    landing/departing phase, attach an "inferred" partial route so there's
 *    still something to show.
 *  - cache hit, but contradicted by direct observation -> trust our own eyes:
 *    drop the cached endpoints, attach an "inferred" partial route instead.
 *  - cache hit, not contradicted -> attach as "typical" (unverified but not
 *    disproven either).
 * See docs/SPEC.md §12.
 */
export async function attachRoutes(states: StateVector[]): Promise<EnrichedStateVector[]> {
  const callsigns = [
    ...new Set(states.map((s) => s.callsign).filter((c): c is string => !!c)),
  ];
  const cached = await getFreshRoutes(callsigns);

  return states.map((s) => {
    const phase = inferFlightPhase(s);
    const inferredFallback = phase ? { ...s, route: buildInferredRoute(phase) } : s;

    if (!s.callsign) return inferredFallback;

    const hit = cached.get(s.callsign);
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
