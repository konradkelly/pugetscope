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
  const [expanded, setExpanded] = useState<string | null>(null);

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

  function handleDelete(icao24: string, sightingId: number) {
    api
      .deleteSpotting(sightingId)
      .then(() => {
        let removedAircraft = false;
        setEntries((prev) => {
          if (!prev) return prev;
          return prev
            .map((e) => {
              if (e.icao24 !== icao24) return e;
              const sightings = e.sightings.filter((s) => s.id !== sightingId);
              if (sightings.length === 0) removedAircraft = true;
              return {
                ...e,
                sightings,
                timesSpotted: sightings.length,
                firstSpottedAt: sightings[sightings.length - 1]?.spottedAt ?? e.firstSpottedAt,
                lastSpottedAt: sightings[0]?.spottedAt ?? e.lastSpottedAt,
              };
            })
            .filter((e) => e.sightings.length > 0);
        });
        setTotals((prev) =>
          prev
            ? {
                totalSightings: prev.totalSightings - 1,
                uniqueAircraft: removedAircraft ? prev.uniqueAircraft - 1 : prev.uniqueAircraft,
              }
            : prev,
        );
      })
      .catch((err) => setError(err.message));
  }

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
          {entries.map((e) => {
            const isExpanded = expanded === e.icao24;
            return (
              <li key={e.icao24} className="rounded bg-sky-50 px-2 py-1.5 transition-colors hover:bg-sky-100">
                <button
                  className="w-full text-left"
                  onClick={() => setExpanded(isExpanded ? null : e.icao24)}
                >
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
                      ? `${formatDate(e.firstSpottedAt)} – ${formatDate(e.lastSpottedAt)} (tap for all dates)`
                      : formatDate(e.lastSpottedAt)}
                  </div>
                </button>

                {isExpanded && (
                  <ul className="mt-1.5 space-y-1 border-t border-sky-100 pt-1.5">
                    {e.sightings.map((s) => (
                      <li key={s.id}>
                        <button
                          onClick={() => handleDelete(e.icao24, s.id)}
                          className="flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-[11px] text-gray-500 transition-colors hover:bg-gray-100"
                          title="Click to delete this spotting"
                          aria-label={`Delete sighting from ${formatDate(s.spottedAt)}`}
                        >
                          <span>{formatDate(s.spottedAt)}</span>
                          <span className="text-gray-400">✕</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
