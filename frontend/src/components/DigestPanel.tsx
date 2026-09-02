import { useEffect, useState } from "react";
import { api, type CurrentUser, type Digest } from "../lib/api.js";
import { Panel, PanelHeader } from "./Panel.js";

interface Props {
  user: CurrentUser | null;
  date: string;
  onClose: () => void;
}

export function DigestPanel({ user, date, onClose }: Props) {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [subscribePending, setSubscribePending] = useState(false);

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

  useEffect(() => {
    if (!user) {
      setSubscribed(null);
      return;
    }
    let cancelled = false;
    api
      .getDigestSubscription()
      .then((data) => {
        if (!cancelled) setSubscribed(data.subscribed);
      })
      .catch(() => {
        // Subscription status is a nice-to-have here — leave the toggle
        // showing its "loading" state rather than surfacing a second error
        // alongside the digest content's own error handling above.
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  function handleToggleSubscribe() {
    setSubscribePending(true);
    const action = subscribed ? api.unsubscribeDigest() : api.subscribeDigest();
    action
      .then(() => setSubscribed((prev) => !prev))
      .catch((err) => setError(err.message))
      .finally(() => setSubscribePending(false));
  }

  return (
    <Panel className="w-full p-4 sm:w-[420px]">
      <PanelHeader title="Daily digest" subtitle={date} onClose={onClose} />

      {user ? (
        <button
          onClick={handleToggleSubscribe}
          disabled={subscribePending || subscribed === null}
          className={`mt-2 rounded px-3 py-1 text-xs disabled:opacity-50 ${
            subscribed
              ? "bg-gray-100 text-gray-600 hover:bg-gray-200"
              : "bg-sky-100 text-sky-700 hover:bg-sky-200"
          }`}
        >
          {subscribePending
            ? "…"
            : subscribed
              ? "Unsubscribe from email digest"
              : "Email me the daily digest"}
        </button>
      ) : (
        <p className="mt-2 text-xs text-gray-400">Log in to get this by email every day.</p>
      )}

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
