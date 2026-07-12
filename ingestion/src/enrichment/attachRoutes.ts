import type { StateVector } from "../openskyClient.js";
import type { FlightRoute } from "./adsbdbClient.js";
import { getFreshRoutes } from "../db/flightRoutes.js";
import { enqueueLookup } from "./routeLookupWorker.js";

export type EnrichedStateVector = StateVector & { route?: FlightRoute };

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
    return hit.found && hit.route ? { ...s, route: hit.route } : s;
  });
}
