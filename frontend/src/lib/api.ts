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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
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

  logSpotting: (icao24: string) =>
    request<SpottingResult>("/spottings", {
      method: "POST",
      body: JSON.stringify({ icao24 }),
    }),

  getSpottings: () => request<SpottingLog>("/spottings"),

  deleteSpotting: (id: number) =>
    request<void>(`/spottings/${id}`, { method: "DELETE" }),
};
