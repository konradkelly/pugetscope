import { useEffect, useState } from "react";
import { api, type AircraftDetail } from "../lib/api.js";
import type { Airport, RouteConfidence, StateVector } from "../lib/useAircraftFeed.js";

interface Props {
  icao24: string;
  live: StateVector | undefined;
  onClose: () => void;
}

function airportCode(a: Airport | null | undefined): string {
  // "—" for a genuinely unknown endpoint (e.g. an "inferred" partial route
  // only knows the in-region side — see docs/SPEC.md §12 tier 2), matching
  // the same placeholder used elsewhere in this panel.
  return a?.iata || a?.icao || "—";
}

// See docs/SPEC.md §12 — only "typical" is produced today; "inferred"/"live"
// are reserved for the own-track-inference and FIDS tiers.
const CONFIDENCE_LABEL: Record<RouteConfidence, string> = {
  live: "confirmed live",
  inferred: "inferred from live position",
  typical: "typical route for this callsign — not confirmed live",
};

export function AircraftDetailPanel({ icao24, live, onClose }: Props) {
  const [detail, setDetail] = useState<AircraftDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    api
      .getAircraftDetail(icao24)
      .then(setDetail)
      .catch((err) => setError(err.message));
  }, [icao24]);

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
    </div>
  );
}
