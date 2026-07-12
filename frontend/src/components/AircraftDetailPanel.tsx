import { useEffect, useState } from "react";
import { api, type AircraftDetail } from "../lib/api.js";
import type { StateVector } from "../lib/useAircraftFeed.js";

interface Props {
  icao24: string;
  live: StateVector | undefined;
  onClose: () => void;
}

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

  return (
    <div className="absolute right-4 top-4 w-72 rounded-lg bg-white/95 p-4 shadow-lg backdrop-blur">
      <div className="flex items-start justify-between">
        <h2 className="text-lg font-semibold">
          {live?.callsign?.trim() || icao24}
        </h2>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-700"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-sm">
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
