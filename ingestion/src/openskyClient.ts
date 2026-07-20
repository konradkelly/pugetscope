import { fetch, ProxyAgent, type Dispatcher } from "undici";
import { config } from "./config.js";

// Shared across every OpenSky call (token, states, and the aircraft database
// download in loadAircraftDatabase.ts) — undefined dispatcher falls back to
// undici's default (direct connection). OpenSky blocks AWS-origin traffic, so
// anything hitting opensky-network.org from this deployment needs this.
export const proxyAgent: Dispatcher | undefined = config.opensky.proxyUrl
  ? new ProxyAgent(config.opensky.proxyUrl)
  : undefined;

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

export interface StateVector {
  icao24: string;
  callsign: string | null;
  originCountry: string;
  timePosition: number | null;
  lastContact: number;
  longitude: number | null;
  latitude: number | null;
  baroAltitude: number | null;
  onGround: boolean;
  velocity: number | null;
  trueTrack: number | null;
  verticalRate: number | null;
  geoAltitude: number | null;
  squawk: string | null;
  spi: boolean;
}

// Field order per OpenSky REST API docs — see docs/SPEC.md §4
type RawStateRow = [
  string, // 0 icao24
  string | null, // 1 callsign
  string, // 2 origin_country
  number | null, // 3 time_position
  number, // 4 last_contact
  number | null, // 5 longitude
  number | null, // 6 latitude
  number | null, // 7 baro_altitude
  boolean, // 8 on_ground
  number | null, // 9 velocity
  number | null, // 10 true_track
  number | null, // 11 vertical_rate
  unknown, // 12 sensors
  number | null, // 13 geo_altitude
  string | null, // 14 squawk
  boolean, // 15 spi
  number, // 16 position_source
  number?, // 17 category
];

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

async function fetchToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 30_000) {
    return cachedToken.accessToken;
  }

  const res = await fetch(config.opensky.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.opensky.clientId,
      client_secret: config.opensky.clientSecret,
    }),
    dispatcher: proxyAgent,
  });

  if (!res.ok) {
    throw new Error(
      `OpenSky token request failed: ${res.status} ${await res.text()}`,
    );
  }

  const body = (await res.json()) as TokenResponse;
  cachedToken = {
    accessToken: body.access_token,
    expiresAt: now + body.expires_in * 1000,
  };
  return cachedToken.accessToken;
}

export class RateLimitedError extends Error {
  constructor(public retryAfterSeconds: number) {
    super(`OpenSky rate limit hit, retry after ${retryAfterSeconds}s`);
  }
}

function parseRow(row: RawStateRow): StateVector {
  return {
    icao24: row[0],
    callsign: row[1]?.trim() || null,
    originCountry: row[2],
    timePosition: row[3],
    lastContact: row[4],
    longitude: row[5],
    latitude: row[6],
    baroAltitude: row[7],
    onGround: row[8],
    velocity: row[9],
    trueTrack: row[10],
    verticalRate: row[11],
    geoAltitude: row[13],
    squawk: row[14],
    spi: row[15],
  };
}

export async function fetchPugetSoundStates(): Promise<StateVector[]> {
  const token = await fetchToken();
  const { lamin, lomin, lamax, lomax } = config.bbox;
  const url = new URL(config.opensky.statesUrl);
  url.searchParams.set("lamin", String(lamin));
  url.searchParams.set("lomin", String(lomin));
  url.searchParams.set("lamax", String(lamax));
  url.searchParams.set("lomax", String(lomax));

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    dispatcher: proxyAgent,
  });

  if (res.status === 401) {
    // token may have been invalidated server-side; force a refresh next call
    cachedToken = null;
    throw new Error("OpenSky rejected token (401) — will refresh on retry");
  }

  if (res.status === 429) {
    const retryAfter = Number(
      res.headers.get("X-Rate-Limit-Retry-After-Seconds") ?? "60",
    );
    throw new RateLimitedError(retryAfter);
  }

  if (!res.ok) {
    throw new Error(
      `OpenSky states request failed: ${res.status} ${await res.text()}`,
    );
  }

  const body = (await res.json()) as { time: number; states: RawStateRow[] | null };
  return (body.states ?? [])
    .map(parseRow)
    .filter((s) => s.latitude !== null && s.longitude !== null);
}
