import { config } from "./config.js";

export interface AircraftDetail {
  icao24: string;
  registration: string | null;
  manufacturer: string | null;
  model: string | null;
  typecode: string | null;
  operator: string | null;
  first_seen: string | null;
  last_seen: string | null;
  latest: unknown;
}

export interface CurrentUser {
  id: string;
  email: string;
}

export interface OverflightHour {
  hour: number;
  overflights: number;
  avgAltitude: number | null;
  minAltitude: number | null;
}

export interface OverflightSummary {
  zip: string;
  lookbackDays: number;
  hours: OverflightHour[];
}

export interface OverflightEvent {
  icao24: string;
  callsign: string | null;
  altitude: number | null;
  ground_speed: number | null;
  heading: number | null;
  recorded_at: string;
  registration: string | null;
  manufacturer: string | null;
  model: string | null;
  operator: string | null;
}

export interface OverflightEvents {
  zip: string;
  from: string;
  to: string;
  events: OverflightEvent[];
}

export interface AirportTraffic {
  icao: string;
  iata: string;
  name: string;
  flights: number;
}

export interface AirportTrafficTotals {
  lookbackDays: number;
  airports: AirportTraffic[];
}

export interface TrafficHour {
  hour: number;
  flights: number;
}

export interface TrafficDayOfWeek {
  dow: number;
  flights: number;
}

export interface TrafficVolume {
  airport: string;
  lookbackDays: number;
  totalFlights: number;
  hourly: TrafficHour[];
  dayOfWeek: TrafficDayOfWeek[];
}

export interface TrafficDay {
  date: string;
  flights: number;
}

export interface RegionTraffic {
  lookbackDays: number;
  totalFlights: number;
  daily: TrafficDay[];
  hourly: TrafficHour[];
}

export type AirportBoardDirection = "departure" | "arrival";

export interface AirportBoardFlight {
  callSign: string;
  flightNumber: string | null;
  airlineName: string | null;
  status: string | null;
  other: { icao: string | null; iata: string | null; name: string | null };
  scheduledTime: string | null;
  revisedTime: string | null;
}

export interface AirportBoard {
  airport: string;
  departures: AirportBoardFlight[];
  arrivals: AirportBoardFlight[];
}

export interface AirportFlow {
  airport: string;
  runway: string | null;
  flow: "north" | "south" | null;
  headingDeg: number | null;
  confidence: "high" | "low" | "unknown";
  sampleSize: number;
  asOf: string | null;
}

export interface SpottingResult {
  id: number;
  icao24: string;
  spottedAt: string;
  duplicate: boolean;
  isFirstSighting: boolean;
}

export interface Sighting {
  id: number;
  spottedAt: string;
}

export interface SpottingLogEntry {
  icao24: string;
  timesSpotted: number;
  firstSpottedAt: string;
  lastSpottedAt: string;
  sightings: Sighting[];
  registration: string | null;
  manufacturer: string | null;
  model: string | null;
  operator: string | null;
}

export interface SpottingLog {
  entries: SpottingLogEntry[];
  uniqueAircraft: number;
  totalSightings: number;
}

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type AlertWatchKind = "geofence" | "callsign";

export interface CreateGeofenceWatch {
  kind: "geofence";
  label?: string;
  lat: number;
  lon: number;
  radiusM: number;
  maxAltitudeM?: number;
}

export interface CreateCallsignWatch {
  kind: "callsign";
  label?: string;
  matchValue: string;
}

export interface ReplayBounds {
  earliest: string | null;
  latest: string | null;
}

export interface ReplayFramePosition {
  icao24: string;
  callsign: string | null;
  lat: number;
  lon: number;
  altitude: number | null;
  groundSpeed: number | null;
  headingDeg: number | null;
  verticalSpeed: number | null;
  recordedAt: string;
  typecode: string | null;
}

export interface ReplayFrame {
  at: string;
  windowSeconds: number;
  aircraft: ReplayFramePosition[];
}

export interface Digest {
  date: string;
  headline: string;
  body: string;
  metaDescription: string;
  stats: {
    date: string;
    totalFlights: number;
    byAirport: Record<string, number>;
    // Absent on digests generated before these fields existed.
    vsLastWeek?: number | null;
    busiestHour?: number | null;
    notableAircraft?: Array<{
      icao24: string;
      registration: string | null;
      manufacturer: string | null;
      model: string | null;
      typecode: string | null;
      operator: string | null;
    }>;
  };
}

export interface AlertWatch {
  id: number;
  kind: AlertWatchKind;
  label: string | null;
  lat: number | null;
  lon: number | null;
  radiusM: number | null;
  maxAltitudeM: number | null;
  matchValue: string | null;
  createdAt: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    credentials: "include",
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  getAircraftDetail: (icao24: string) =>
    request<AircraftDetail>(`/aircraft/${icao24}`),

  getOverflightSummary: (zip: string, days: number) =>
    request<OverflightSummary>(
      `/analytics/overflights/summary?zip=${zip}&days=${days}`,
    ),

  getOverflightEvents: (zip: string, from: string, to: string) =>
    request<OverflightEvents>(
      `/analytics/overflights/events?zip=${zip}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),

  getAirportTrafficTotals: (days: number) =>
    request<AirportTrafficTotals>(`/analytics/traffic/airports?days=${days}`),

  getTrafficVolume: (airport: string, days: number) =>
    request<TrafficVolume>(`/analytics/traffic/volume?airport=${airport}&days=${days}`),

  getRegionTraffic: (days: number) =>
    request<RegionTraffic>(`/analytics/traffic/region?days=${days}`),

  getAirportBoard: (icao: string, direction?: AirportBoardDirection) =>
    request<AirportBoard>(
      `/airports/${icao}/board${direction ? `?direction=${direction}` : ""}`,
    ),

  getAirportFlow: (icao: string) => request<AirportFlow>(`/airports/${icao}/flow`),

  // Plural /digests/:date, not the crawler-facing HTML /digest/:date route —
  // see api/src/routes/digest.ts for why the two are split.
  getDigest: (date: string) => request<Digest>(`/digests/${date}`),

  getReplayBounds: () => request<ReplayBounds>("/replay/bounds"),

  getReplayFrame: (atIso: string, windowSeconds: number) =>
    request<ReplayFrame>(
      `/replay/frame?at=${encodeURIComponent(atIso)}&windowSeconds=${windowSeconds}`,
    ),

  me: () => request<CurrentUser>("/auth/me"),

  signup: (email: string, password: string) =>
    request<CurrentUser>("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  login: (email: string, password: string) =>
    request<CurrentUser>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  logout: () => request<void>("/auth/logout", { method: "POST" }),

  forgotPassword: (email: string) =>
    request<{ ok: true }>("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),

  resetPassword: (token: string, password: string) =>
    request<CurrentUser>("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    }),

  logSpotting: (icao24: string) =>
    request<SpottingResult>("/spottings", {
      method: "POST",
      body: JSON.stringify({ icao24 }),
    }),

  getSpottings: () => request<SpottingLog>("/spottings"),

  deleteSpotting: (id: number) =>
    request<void>(`/spottings/${id}`, { method: "DELETE" }),

  subscribePush: (deviceId: string, subscription: PushSubscriptionPayload) =>
    request<void>("/alerts/subscribe", {
      method: "POST",
      body: JSON.stringify({ deviceId, subscription }),
    }),

  createWatch: (deviceId: string, watch: CreateGeofenceWatch | CreateCallsignWatch) =>
    request<{ id: number }>("/alerts/watches", {
      method: "POST",
      body: JSON.stringify({ deviceId, ...watch }),
    }),

  getWatches: (deviceId: string) =>
    request<{ watches: AlertWatch[] }>(`/alerts/watches?deviceId=${encodeURIComponent(deviceId)}`),

  deleteWatch: (deviceId: string, id: number) =>
    request<void>(`/alerts/watches/${id}?deviceId=${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
    }),
};
