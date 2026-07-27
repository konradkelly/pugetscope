import { useCallback, useEffect, useState } from "react";

export type UrlRoute =
  | { type: "aircraft"; icao24: string }
  | { type: "neighborhood"; zip: string }
  | { type: "airport"; icao: string }
  | { type: "home" };

const AIRCRAFT_RE = /^\/aircraft\/([0-9a-fA-F]{6})$/;
const NEIGHBORHOOD_RE = /^\/neighborhood\/(\d{5})$/;
const AIRPORT_RE = /^\/airport\/([A-Za-z]{4})$/;

function parseRoute(pathname: string): UrlRoute {
  const aircraftMatch = pathname.match(AIRCRAFT_RE);
  if (aircraftMatch) return { type: "aircraft", icao24: aircraftMatch[1].toLowerCase() };

  const neighborhoodMatch = pathname.match(NEIGHBORHOOD_RE);
  if (neighborhoodMatch) return { type: "neighborhood", zip: neighborhoodMatch[1] };

  const airportMatch = pathname.match(AIRPORT_RE);
  if (airportMatch) return { type: "airport", icao: airportMatch[1].toUpperCase() };

  return { type: "home" };
}

/**
 * Lightweight History API wrapper for the app's four deep-linkable
 * states — no router library, since there's only ever one real view (map +
 * overlay panels) to address into.
 */
export function useUrlRoute(): { route: UrlRoute; navigate: (path: string) => void } {
  const [route, setRoute] = useState<UrlRoute>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    function onPopState() {
      setRoute(parseRoute(window.location.pathname));
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((path: string) => {
    if (path !== window.location.pathname) {
      window.history.pushState(null, "", path);
    }
    setRoute(parseRoute(path));
  }, []);

  return { route, navigate };
}
