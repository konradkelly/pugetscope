import { useEffect, useState } from "react";
import { api, type SpottingLogEntry } from "../lib/api.js";

interface Props {
  onClose: () => void;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function SpottingLogPanel({ onClose }: Props) {
  const [entries, setEntries] = useState<SpottingLogEntry[] | null>(null);
  const [totals, setTotals] = useState<{ uniqueAircraft: number; totalSightings: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    api
      .getSpottings()
      .then((data) => {
        if (cancelled) return;
        setEntries(data.entries);
        setTotals({ uniqueAircraft: data.uniqueAircraft, totalSightings: data.totalSightings });
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="w-80 rounded-lg bg-white/95 p-4 shadow-lg backdrop-blur">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold leading-tight">My spotting log</h2>
          <p className="text-sm text-gray-500">
            {totals
              ? `${totals.uniqueAircraft} aircraft · ${totals.totalSightings} sighting${totals.totalSightings === 1 ? "" : "s"}`
              : "Loading…"}
          </p>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-700" aria-label="Close">
          ✕
        </button>
      </div>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {!error && entries && entries.length === 0 && (
        <p className="mt-3 text-sm text-gray-400">
          No sightings logged yet — select an aircraft on the map and log it.
        </p>
      )}

      {!error && entries && entries.length > 0 && (
        <ul className="mt-3 max-h-80 space-y-2 overflow-y-auto text-sm">
          {entries.map((e) => (
            <li key={e.icao24} className="rounded bg-sky-50 px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{e.registration ?? e.icao24}</span>
                <span className="whitespace-nowrap rounded-full bg-sky-600 px-2 py-0.5 text-[10px] font-medium text-white">
                  ×{e.timesSpotted}
                </span>
              </div>
              <div className="text-xs text-gray-500">
                {[e.manufacturer, e.model].filter(Boolean).join(" ") || "Unknown type"}
                {e.operator && <> · {e.operator}</>}
              </div>
              <div className="mt-0.5 text-[10px] text-gray-400">
                {e.timesSpotted > 1
                  ? `${formatDate(e.firstSpottedAt)} – ${formatDate(e.lastSpottedAt)}`
                  : formatDate(e.lastSpottedAt)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
