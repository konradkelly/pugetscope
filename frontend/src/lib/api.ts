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
};
