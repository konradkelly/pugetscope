import { useEffect, useState } from "react";
import { api } from "./api.js";
import type { AircraftByIcao, StateVector } from "./useAircraftFeed.js";

const WINDOW_SECONDS = 90;

// Dragging the scrubber can fire many atMs changes within milliseconds
// (observed: ~7 in under a second) — debouncing collapses those into one
// request for wherever the drag settles, instead of flooding /replay/frame
// (which is what actually caused the rate limiter to reject the bulk of
// requests during ordinary use, not just abuse). Comfortably shorter than
// the 1000ms tick interval driving normal playback, so it doesn't add
// perceptible lag or coalesce genuinely distinct playback frames.
const DEBOUNCE_MS = 200;

// positions rows don't carry live ADS-B category, onGround, spi,
// originCountry, or route (those are only ever attached to the live Redis
// blob — see docs/SPEC.md §16's "real gap" callout) — filled with harmless
// placeholders below, none of which any component actually reads (confirmed
// by grep against onGround/spi/originCountry/lastContact usage).
function toStateVector(pos: {
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
}): StateVector {
  const epochSeconds = Math.floor(new Date(pos.recordedAt).getTime() / 1000);
  return {
    icao24: pos.icao24,
    callsign: pos.callsign,
    originCountry: "",
    timePosition: epochSeconds,
    lastContact: epochSeconds,
    longitude: pos.lon,
    latitude: pos.lat,
    baroAltitude: pos.altitude,
    onGround: false,
    velocity: pos.groundSpeed,
    trueTrack: pos.headingDeg,
    verticalRate: pos.verticalSpeed,
    geoAltitude: pos.altitude,
    squawk: null,
    spi: false,
    category: null,
    typecode: pos.typecode,
  };
}

/**
 * Fetches one replay frame (positions as of `atMs`) and reshapes it into the
 * same AircraftByIcao map useAircraftFeed produces, so AircraftMap/
 * AircraftDetailPanel need no replay-specific branching. `atMs === null`
 * means replay isn't active — returns an empty map without fetching.
 */
export function useReplayFeed(atMs: number | null): {
  aircraft: AircraftByIcao;
  loading: boolean;
  error: string | null;
} {
  const [aircraft, setAircraft] = useState<AircraftByIcao>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (atMs === null) {
      setAircraft(new Map());
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const timer = setTimeout(() => {
      api
        .getReplayFrame(new Date(atMs).toISOString(), WINDOW_SECONDS)
        .then((frame) => {
          if (cancelled) return;
          const next: AircraftByIcao = new Map();
          for (const pos of frame.aircraft) {
            next.set(pos.icao24, toStateVector(pos));
          }
          setAircraft(next);
          setError(null);
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : "replay fetch failed");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [atMs]);

  return { aircraft, loading, error };
}
