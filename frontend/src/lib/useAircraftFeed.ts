import { useEffect, useRef, useState } from "react";
import { config } from "./config.js";

export interface Airport {
  icao: string | null;
  iata: string | null;
  name: string | null;
  lat: number | null;
  lon: number | null;
}

// "typical" = adsbdb's crowd-sourced route, unverified against this specific
// flight. "inferred" = own-track geometry inference. "live" = a real FIDS
// board match — see docs/SPEC.md §12.
export type RouteConfidence = "live" | "inferred" | "typical";

export interface FlightRoute {
  origin: Airport | null;
  destination: Airport | null;
  airline: string | null;
  confidence: RouteConfidence;
  eta?: string; // ISO UTC — only present on a "live" arrival match
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
  // Present only when adsbdb had a route for this callsign (docs/SPEC.md §12).
  route?: FlightRoute;
}

interface FeedMessage {
  type: "snapshot" | "update";
  data: StateVector[];
}

export type AircraftByIcao = Map<string, StateVector>;

/**
 * Connects to the websocket service's /live feed. The "snapshot" and
 * "update" messages both carry the *full* current in-region aircraft
 * list (not deltas — see websocket/src/index.ts), so each message
 * simply replaces the whole map rather than patching individual entries.
 */
export function useAircraftFeed(): { aircraft: AircraftByIcao; connected: boolean } {
  const [aircraft, setAircraft] = useState<AircraftByIcao>(new Map());
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      const ws = new WebSocket(config.wsUrl);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);

      ws.onmessage = (event) => {
        const message: FeedMessage = JSON.parse(event.data);
        const next: AircraftByIcao = new Map();
        for (const state of message.data) {
          next.set(state.icao24, state);
        }
        setAircraft(next);
      };

      ws.onclose = () => {
        setConnected(false);
        if (!cancelled) reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  return { aircraft, connected };
}
