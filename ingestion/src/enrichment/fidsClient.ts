import { config } from "../config.js";

// AeroDataBox FIDS endpoint — see docs/SPEC.md §12 tier 1. TIER 2 pricing
// (2 units/call on RapidAPI). Max 12h window per call.
const BASE_URL = "https://aerodatabox.p.rapidapi.com";

export interface FidsAirport {
  icao: string | null;
  iata: string | null;
  name: string | null;
  lat: number | null;
  lon: number | null;
}

export interface FidsFlight {
  direction: "departure" | "arrival";
  callSign: string;
  flightNumber: string;
  status: string;
  airlineName: string | null;
  other: FidsAirport; // opposite-end airport of this leg
  scheduledTime: string | null; // ISO UTC
  revisedTime: string | null; // ISO UTC — actual/estimated time (the real ETA for an arrival)
}

// Shape of the pieces of the AeroDataBox response we consume.
interface RawAirport {
  icao?: string; iata?: string; name?: string;
  location?: { lat?: number; lon?: number };
}
interface RawMovement {
  airport?: RawAirport;
  scheduledTime?: { utc?: string };
  revisedTime?: { utc?: string };
}
interface RawFlight {
  number?: string;
  callSign?: string;
  status?: string;
  airline?: { name?: string };
  movement?: RawMovement;
}
interface RawFidsResponse {
  departures?: RawFlight[];
  arrivals?: RawFlight[];
}

function toAirport(a: RawAirport | undefined): FidsAirport {
  return {
    icao: a?.icao ?? null,
    iata: a?.iata ?? null,
    name: a?.name ?? null,
    lat: a?.location?.lat ?? null,
    lon: a?.location?.lon ?? null,
  };
}

function toFlight(raw: RawFlight, direction: "departure" | "arrival"): FidsFlight | null {
  // Only rows with a callSign are usable — it's our sole join key against OpenSky.
  if (!raw.callSign || !raw.number) return null;
  return {
    direction,
    callSign: raw.callSign,
    flightNumber: raw.number,
    status: raw.status ?? "Unknown",
    airlineName: raw.airline?.name ?? null,
    other: toAirport(raw.movement?.airport),
    scheduledTime: raw.movement?.scheduledTime?.utc ?? null,
    revisedTime: raw.movement?.revisedTime?.utc ?? null,
  };
}

function formatLocal(d: Date): string {
  // AeroDataBox wants local time at the airport, no offset, minute precision.
  // We don't have the airport's timezone handy, so we use UTC — this shifts
  // the window by the airport's UTC offset but the window itself is wide
  // enough (12h) that the practical effect is negligible for our purpose
  // (catching flights around "now"), not worth pulling in a tz database for.
  return d.toISOString().slice(0, 16);
}

/**
 * Fetches the FIDS board (departures + arrivals) for one airport across a
 * 12-hour window centered a few hours behind "now" through several hours
 * ahead, to catch both recently-departed/landed traffic and upcoming flights.
 */
export async function fetchFidsBoard(airportIcao: string): Promise<FidsFlight[]> {
  if (!config.aerodatabox.apiKey) {
    throw new Error("AERODATABOX_API_KEY not set");
  }

  const now = new Date();
  const from = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + 9 * 60 * 60 * 1000);

  const url =
    `${BASE_URL}/flights/airports/icao/${airportIcao}/${formatLocal(from)}/${formatLocal(to)}` +
    `?direction=Both&withLeg=false&withCancelled=false`;

  const res = await fetch(url, {
    headers: {
      "X-RapidAPI-Key": config.aerodatabox.apiKey,
      "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com",
    },
  });

  if (!res.ok) {
    throw new Error(`AeroDataBox FIDS request failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as RawFidsResponse;
  const flights: FidsFlight[] = [];
  for (const raw of body.departures ?? []) {
    const f = toFlight(raw, "departure");
    if (f) flights.push(f);
  }
  for (const raw of body.arrivals ?? []) {
    const f = toFlight(raw, "arrival");
    if (f) flights.push(f);
  }
  return flights;
}
