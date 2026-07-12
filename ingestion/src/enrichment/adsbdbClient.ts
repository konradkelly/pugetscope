// Free, no-account callsign -> route lookup. See docs/SPEC.md §12.
// 200 with response.flightroute on a hit; 404 {"response":"unknown callsign"} on a miss.
const ADSBDB_URL = "https://api.adsbdb.com/v0/callsign";

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

// Shape of the pieces of the adsbdb response we consume.
interface AdsbdbAirport {
  icao_code?: string;
  iata_code?: string;
  name?: string;
  latitude?: number;
  longitude?: number;
}
interface AdsbdbResponse {
  response?: {
    flightroute?: {
      airline?: { name?: string };
      origin?: AdsbdbAirport;
      destination?: AdsbdbAirport;
    };
  };
}

function toAirport(a: AdsbdbAirport | undefined): Airport | null {
  if (!a) return null;
  return {
    icao: a.icao_code ?? null,
    iata: a.iata_code ?? null,
    name: a.name ?? null,
    lat: a.latitude ?? null,
    lon: a.longitude ?? null,
  };
}

export type LookupResult =
  | { found: true; route: FlightRoute }
  | { found: false };

/**
 * Looks up a single callsign. Returns { found: false } for a clean miss (404)
 * so the caller can negative-cache it. Throws only on unexpected/transient
 * errors (network, 5xx, rate limiting) so the caller can retry later rather
 * than poison the cache with a false negative.
 */
export async function lookupCallsign(callsign: string): Promise<LookupResult> {
  const res = await fetch(`${ADSBDB_URL}/${encodeURIComponent(callsign)}`, {
    headers: {
      // Identify ourselves to a volunteer-run API (docs/SPEC.md §12).
      "User-Agent": "pugetscope/0.1 (+https://github.com/konradkelly/pugetscope)",
    },
  });

  if (res.status === 404) return { found: false };
  if (!res.ok) {
    throw new Error(`adsbdb lookup failed for ${callsign}: ${res.status}`);
  }

  const body = (await res.json()) as AdsbdbResponse;
  const route = body.response?.flightroute;
  if (!route) return { found: false };

  return {
    found: true,
    route: {
      origin: toAirport(route.origin),
      destination: toAirport(route.destination),
      airline: route.airline?.name ?? null,
    },
  };
}
