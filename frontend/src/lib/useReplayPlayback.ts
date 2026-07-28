import { useEffect, useRef, useState } from "react";
import { api, type ReplayBounds } from "./api.js";
import { useReplayFeed } from "./useReplayFeed.js";
import type { AircraftByIcao } from "./useAircraftFeed.js";

export type ReplaySpeed = 1 | 5 | 20;

const TICK_MS = 1000;

// Starting the scrubber at the exact latest position leaves nothing to play
// forward to — hitting Play would immediately hit the end-of-data clamp
// below and re-pause within one tick. Back off by a fixed window so there's
// real room to watch, still recent enough to match "what flew over a few
// minutes ago."
const DEFAULT_START_LOOKBACK_MS = 15 * 60 * 1000;

export interface ReplayPlayback {
  bounds: ReplayBounds | null;
  currentMs: number | null;
  playing: boolean;
  speed: ReplaySpeed;
  aircraft: AircraftByIcao;
  loading: boolean;
  error: string | null;
  seek: (ms: number) => void;
  setPlaying: (playing: boolean) => void;
  setSpeed: (speed: ReplaySpeed) => void;
}

/**
 * Owns the replay scrubber's timeline state (current position, play/pause,
 * speed) plus the data fetch for whatever frame that timeline currently
 * points at. Only does any work while `enabled` — App.tsx keeps this hook
 * mounted permanently but toggles `enabled` with the "Replay" rail item, so
 * switching away costs nothing (no bounds fetch, no ticking, no polling).
 */
export function useReplayPlayback(enabled: boolean): ReplayPlayback {
  const [bounds, setBounds] = useState<ReplayBounds | null>(null);
  const [currentMs, setCurrentMs] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const boundsRequested = useRef(false);

  // Fetch bounds once, the first time replay is turned on.
  useEffect(() => {
    if (!enabled || boundsRequested.current) return;
    boundsRequested.current = true;

    api.getReplayBounds().then((b) => {
      setBounds(b);
      if (b.latest) {
        const latestMs = new Date(b.latest).getTime();
        const earliestMs = b.earliest ? new Date(b.earliest).getTime() : latestMs;
        setCurrentMs(Math.max(earliestMs, latestMs - DEFAULT_START_LOOKBACK_MS));
      }
    });
  }, [enabled]);

  // Advance the timeline while playing — real-time ticks, sim-time steps of
  // `speed` seconds per tick, clamped to the latest available position and
  // auto-pausing there (nothing further to replay past that point).
  useEffect(() => {
    if (!enabled || !playing || !bounds?.latest) return;

    const latestMs = new Date(bounds.latest).getTime();
    const interval = setInterval(() => {
      setCurrentMs((prev) => {
        if (prev === null) return prev;
        const next = prev + speed * TICK_MS;
        if (next >= latestMs) {
          setPlaying(false);
          return latestMs;
        }
        return next;
      });
    }, TICK_MS);

    return () => clearInterval(interval);
  }, [enabled, playing, speed, bounds?.latest]);

  function seek(ms: number) {
    setCurrentMs(ms);
  }

  const { aircraft, loading, error } = useReplayFeed(enabled ? currentMs : null);

  return { bounds, currentMs, playing, speed, aircraft, loading, error, seek, setPlaying, setSpeed };
}
