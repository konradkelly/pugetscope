import type { StateVector } from "../openskyClient.js";
import type { FlightRoute } from "./adsbdbClient.js";
import { getFreshRoutes } from "../db/flightRoutes.js";
import { enqueueLookup } from "./routeLookupWorker.js";
import { inferFlightPhase } from "./regionalAirports.js";

// "typical" = adsbdb's crowd-sourced route, unverified against this specific
// flight. "inferred"/"live" are reserved for docs/SPEC.md §12 tiers 2/1
// (own-track inference, FIDS match) — not built yet, but the field exists now
// so those tiers slot in without another round of plumbing changes.
export type RouteConfidence = "live" | "inferred" | "typical";
export type EnrichedRoute = FlightRoute & { confidence: RouteConfidence };
export type EnrichedStateVector = StateVector & { route?: EnrichedRoute };

/**
 * A cached route is "contradicted" when we can directly observe (via
 * inferFlightPhase) that this aircraft is landing at or departing from a
 * regional airport other than what the route claims. E.g. adsbdb says
 * PDX->JFK but the aircraft is visibly descending into SEA right now — the
 * cached route describes what this callsign *usually* flies, not this leg.
 * See docs/SPEC.md §12 "Routing accuracy upgrade" — plausibility suppression.
 */
function isContradicted(state: StateVector, route: FlightRoute): boolean {
  const phase = inferFlightPhase(state);
  if (!phase) return false; // no direct observation to check against — can't contradict

  const claimedIcao =
    phase.kind === "landing" ? route.destination?.icao : route.origin?.icao;
  if (!claimedIcao) return false; // route doesn't even claim an airport here

  return claimedIcao.toUpperCase() !== phase.airportIcao;
}

/**
 * Attaches cached route info (origin/destination/airline) to states whose
 * callsign has a fresh cache hit. For callsigns that are missing or stale in
 * the cache, enqueues an async lookup (which populates the cache for a future
 * poll) — the external API is never called from this path, keeping the poll
 * loop fast. See docs/SPEC.md §12.
 */
export async function attachRoutes(states: StateVector[]): Promise<EnrichedStateVector[]> {
  const callsigns = [
    ...new Set(states.map((s) => s.callsign).filter((c): c is string => !!c)),
  ];
  const cached = await getFreshRoutes(callsigns);

  return states.map((s) => {
    if (!s.callsign) return s;
    const hit = cached.get(s.callsign);
    if (!hit) {
      enqueueLookup(s.callsign); // missing or stale — refresh in the background
      return s;
    }
    // found === false is a fresh negative-cache hit: known to have no route,
    // so attach nothing and don't re-enqueue.
    if (!hit.found || !hit.route) return s;

    if (isContradicted(s, hit.route)) return s; // suppress rather than show a known-wrong route

    return { ...s, route: { ...hit.route, confidence: "typical" } };
  });
}
