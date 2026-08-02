import { useEffect, useState } from "react";
import { MapPin, Trash2 } from "lucide-react";
import { api, type AlertWatch } from "../lib/api.js";
import { getDeviceId } from "../lib/deviceId.js";
import { ensurePushSubscription, pushSupported } from "../lib/push.js";
import { Panel, PanelHeader } from "./Panel.js";

interface Props {
  onClose: () => void;
  pinDropArmed: boolean;
  onArmPinDrop: () => void;
  droppedPin: { lat: number; lng: number } | null;
  onClearDroppedPin: () => void;
}

const RADIUS_OPTIONS_M = [500, 1000, 3000, 5000];
const ALTITUDE_OPTIONS_M = [
  { value: "", label: "Any altitude" },
  { value: "500", label: "Below 500m" },
  { value: "1500", label: "Below 1500m" },
  { value: "3000", label: "Below 3000m" },
];

export function AlertsPanel({ onClose, pinDropArmed, onArmPinDrop, droppedPin, onClearDroppedPin }: Props) {
  const [watches, setWatches] = useState<AlertWatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [callsignInput, setCallsignInput] = useState("");
  const [callsignPending, setCallsignPending] = useState(false);

  const [radiusM, setRadiusM] = useState(RADIUS_OPTIONS_M[1]);
  const [maxAltitudeM, setMaxAltitudeM] = useState("");
  const [pinLabel, setPinLabel] = useState("");
  const [pinPending, setPinPending] = useState(false);

  function loadWatches() {
    const deviceId = getDeviceId();
    api
      .getWatches(deviceId)
      .then((data) => setWatches(data.watches))
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    loadWatches();
  }, []);

  async function handleCreateCallsignWatch(e: React.FormEvent) {
    e.preventDefault();
    const matchValue = callsignInput.trim();
    if (!matchValue) return;

    setCallsignPending(true);
    setError(null);
    try {
      const deviceId = await ensurePushSubscription();
      await api.createWatch(deviceId, { kind: "callsign", matchValue, label: matchValue });
      setCallsignInput("");
      loadWatches();
    } catch (err) {
      setError(err instanceof Error ? err.message : "something went wrong");
    } finally {
      setCallsignPending(false);
    }
  }

  async function handleCreateGeofenceWatch(e: React.FormEvent) {
    e.preventDefault();
    if (!droppedPin) return;

    setPinPending(true);
    setError(null);
    try {
      const deviceId = await ensurePushSubscription();
      await api.createWatch(deviceId, {
        kind: "geofence",
        lat: droppedPin.lat,
        lon: droppedPin.lng,
        radiusM,
        maxAltitudeM: maxAltitudeM ? Number(maxAltitudeM) : undefined,
        label: pinLabel.trim() || undefined,
      });
      onClearDroppedPin();
      setPinLabel("");
      setMaxAltitudeM("");
      loadWatches();
    } catch (err) {
      setError(err instanceof Error ? err.message : "something went wrong");
    } finally {
      setPinPending(false);
    }
  }

  function handleDelete(id: number) {
    const deviceId = getDeviceId();
    api
      .deleteWatch(deviceId, id)
      .then(() => setWatches((prev) => prev?.filter((w) => w.id !== id) ?? prev))
      .catch((err) => setError(err.message));
  }

  return (
    <Panel className="w-full p-4 sm:w-80">
      <PanelHeader
        title="Alerts"
        subtitle="Notify this browser — no account needed"
        onClose={onClose}
      />

      {!pushSupported() && (
        <p className="mt-2 text-sm text-gray-400">
          Push notifications aren't supported in this browser.
        </p>
      )}

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-3 border-t border-gray-100 pt-3">
        <h3 className="text-sm font-semibold">Watch a callsign or tail number</h3>
        <form onSubmit={handleCreateCallsignWatch} className="mt-1.5 flex gap-1.5">
          <input
            value={callsignInput}
            onChange={(e) => setCallsignInput(e.target.value)}
            placeholder="e.g. DAL889 or a1b2c3"
            maxLength={8}
            className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm uppercase"
          />
          <button
            type="submit"
            disabled={callsignPending || !callsignInput.trim()}
            className="rounded bg-sky-600 px-3 py-1 text-sm text-white hover:bg-sky-700 disabled:opacity-50"
          >
            {callsignPending ? "…" : "Add"}
          </button>
        </form>
      </div>

      <div className="mt-3 border-t border-gray-100 pt-3">
        <h3 className="text-sm font-semibold">Watch a location</h3>

        {!droppedPin ? (
          <button
            onClick={onArmPinDrop}
            className={`mt-1.5 flex w-full items-center justify-center gap-1.5 rounded py-1 text-sm ${
              pinDropArmed
                ? "bg-sky-100 text-sky-700"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
          >
            <MapPin size={16} />
            {pinDropArmed ? "Click the map to place a pin…" : "Drop a pin"}
          </button>
        ) : (
          <form onSubmit={handleCreateGeofenceWatch} className="mt-1.5 space-y-1.5">
            <input
              value={pinLabel}
              onChange={(e) => setPinLabel(e.target.value)}
              placeholder="Label (e.g. My house)"
              maxLength={100}
              className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
            />
            <div className="flex gap-1.5">
              <select
                value={radiusM}
                onChange={(e) => setRadiusM(Number(e.target.value))}
                className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
              >
                {RADIUS_OPTIONS_M.map((r) => (
                  <option key={r} value={r}>
                    {r < 1000 ? `${r}m` : `${r / 1000}km`} radius
                  </option>
                ))}
              </select>
              <select
                value={maxAltitudeM}
                onChange={(e) => setMaxAltitudeM(e.target.value)}
                className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
              >
                {ALTITUDE_OPTIONS_M.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-1.5">
              <button
                type="submit"
                disabled={pinPending}
                className="flex-1 rounded bg-sky-600 py-1 text-sm text-white hover:bg-sky-700 disabled:opacity-50"
              >
                {pinPending ? "Saving…" : "Save alert"}
              </button>
              <button
                type="button"
                onClick={onClearDroppedPin}
                className="rounded bg-gray-100 px-3 py-1 text-sm text-gray-600 hover:bg-gray-200"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>

      {watches && watches.length > 0 && (
        <ul className="mt-3 max-h-48 space-y-1.5 overflow-y-auto border-t border-gray-100 pt-3 text-sm">
          {watches.map((w) => (
            <li
              key={w.id}
              className="flex items-center justify-between gap-2 rounded bg-sky-50 px-2 py-1.5"
            >
              <span className="truncate">
                {w.label || (w.kind === "callsign" ? w.matchValue : "Location alert")}
                <span className="ml-1 text-xs text-gray-400">
                  {w.kind === "geofence" ? `· ${((w.radiusM ?? 0) / 1000).toFixed(1)}km` : ""}
                </span>
              </span>
              <button
                onClick={() => handleDelete(w.id)}
                aria-label="Delete alert"
                className="-m-2 shrink-0 p-2 text-gray-400 hover:text-red-600"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
