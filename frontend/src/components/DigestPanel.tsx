import { useEffect, useState } from "react";
import { api, type Digest } from "../lib/api.js";
import { Panel, PanelHeader } from "./Panel.js";

interface Props {
  date: string;
  onClose: () => void;
}

export function DigestPanel({ date, onClose }: Props) {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDigest(null);
    setError(null);
    api
      .getDigest(date)
      .then((data) => {
        if (!cancelled) setDigest(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [date]);

  return (
    <Panel className="w-[420px] p-4">
      <PanelHeader title="Daily digest" subtitle={date} onClose={onClose} />

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {!error && !digest && <p className="mt-3 text-sm text-gray-500">Loading…</p>}

      {!error && digest && (
        <div className="mt-3">
          <h3 className="text-base font-semibold leading-snug text-gray-900">{digest.headline}</h3>
          <p className="mt-2 whitespace-pre-line text-sm text-gray-700">{digest.body}</p>

          <div className="mt-3 rounded-md bg-sky-50 px-3 py-2 text-xs text-gray-600">
            <span className="font-medium text-sky-900">{digest.stats.totalFlights.toLocaleString()}</span>{" "}
            flights region-wide
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
              {Object.entries(digest.stats.byAirport).map(([icao, flights]) => (
                <span key={icao}>
                  {icao}: {flights.toLocaleString()}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}
