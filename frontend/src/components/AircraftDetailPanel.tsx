import { useEffect, useState } from "react";
import { api, type AircraftDetail, type CurrentUser, type SpottingResult } from "../lib/api.js";
import type { Airport, RouteConfidence, StateVector } from "../lib/useAircraftFeed.js";

interface Props {
  icao24: string;
  live: StateVector | undefined;
  user: CurrentUser | null;
  onClose: () => void;
}

type LogState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; result: SpottingResult }
  | { status: "error"; message: string };

function airportCode(a: Airport | null | undefined): string {
  // "—" for a genuinely unknown endpoint (e.g. an "inferred" partial route
  // only knows the in-region side — see docs/SPEC.md §12 tier 2), matching
  // the same placeholder used elsewhere in this panel.
  return a?.iata || a?.icao || "—";
}

// See docs/SPEC.md §12.
const CONFIDENCE_LABEL: Record<RouteConfidence, string> = {
  live: "confirmed live — airport schedule match",
  inferred: "inferred from live position",
};

function formatEta(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const minutes = Math.round((d.getTime() - now) / 60_000);
  const clock = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (minutes <= 0) return `${clock} (any moment)`;
  if (minutes < 60) return `${clock} (~${minutes} min)`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${clock} (~${hours}h ${mins}m)`;
}

export function AircraftDetailPanel({ icao24, live, user, onClose }: Props) {
  const [detail, setDetail] = useState<AircraftDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logState, setLogState] = useState<LogState>({ status: "idle" });

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    setLogState({ status: "idle" });
    api
      .getAircraftDetail(icao24)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [icao24]);

  async function handleLogSighting() {
    setLogState({ status: "pending" });
    try {
      const result = await api.logSpotting(icao24);
      setLogState({ status: "done", result });
    } catch (err) {
      setLogState({
        status: "error",
        message: err instanceof Error ? err.message : "something went wrong",
      });
    }
  }

  const route = live?.route;

  return (
    <div className="absolute right-4 top-4 w-72 rounded-lg bg-white/95 p-4 shadow-lg backdrop-blur">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold leading-tight">
            {live?.callsign?.trim() || icao24}
          </h2>
          {route?.airline && (
            <p className="text-sm text-gray-500">{route.airline}</p>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-700"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {route && (route.origin || route.destination) && (
        <div className="mt-3 rounded bg-sky-50 p-2">
          <div className="flex items-center justify-center gap-2 font-semibold">
            <span>{airportCode(route.origin)}</span>
            <span className="text-gray-400">→</span>
            <span>{airportCode(route.destination)}</span>
          </div>
          <div className="mt-1 flex justify-between gap-2 text-[11px] leading-tight text-gray-500">
            <span className="flex-1 text-left">{route.origin?.name ?? ""}</span>
            <span className="flex-1 text-right">{route.destination?.name ?? ""}</span>
          </div>
          {route.eta && (
            <p className="mt-1 text-center text-xs font-medium text-sky-700">
              ETA {formatEta(route.eta)}
            </p>
          )}
          <p className="mt-1 text-center text-[10px] text-gray-400">
            {CONFIDENCE_LABEL[route.confidence]}
          </p>
        </div>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-x-2 gap-y-1 text-sm">
        <dt className="text-gray-500">ICAO24</dt>
        <dd>{icao24}</dd>

        <dt className="text-gray-500">Registration</dt>
        <dd>{detail?.registration ?? "—"}</dd>

        <dt className="text-gray-500">Model</dt>
        <dd>{detail?.model ?? "—"}</dd>

        <dt className="text-gray-500">Operator</dt>
        <dd>{detail?.operator ?? "—"}</dd>

        <dt className="text-gray-500">Altitude</dt>
        <dd>{live?.geoAltitude != null ? `${Math.round(live.geoAltitude)} m` : "—"}</dd>

        <dt className="text-gray-500">Ground speed</dt>
        <dd>{live?.velocity != null ? `${Math.round(live.velocity)} m/s` : "—"}</dd>

        <dt className="text-gray-500">Heading</dt>
        <dd>{live?.trueTrack != null ? `${Math.round(live.trueTrack)}°` : "—"}</dd>

        <dt className="text-gray-500">Vertical speed</dt>
        <dd>
          {live?.verticalRate != null ? `${live.verticalRate.toFixed(1)} m/s` : "—"}
        </dd>
      </dl>

      {user && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <button
            onClick={handleLogSighting}
            disabled={logState.status === "pending" || logState.status === "done"}
            className="w-full rounded bg-sky-600 py-1 text-sm text-white hover:bg-sky-700 disabled:opacity-50"
          >
            {logState.status === "done"
              ? "✓ Logged"
              : logState.status === "pending"
                ? "Logging…"
                : "📋 Log this sighting"}
          </button>
          {logState.status === "done" && (
            <p className="mt-1 text-center text-xs text-gray-500">
              {logState.result.isFirstSighting
                ? "First time logging this one!"
                : logState.result.duplicate
                  ? "Already logged within the last hour"
                  : "Added to your spotting log"}
            </p>
          )}
          {logState.status === "error" && (
            <p className="mt-1 text-center text-xs text-red-600">{logState.message}</p>
          )}
        </div>
      )}
    </div>
  );
}
