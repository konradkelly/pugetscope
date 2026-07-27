import { useEffect, useRef, useState } from "react";
import { api, type AirportBoardDirection, type AirportBoardFlight } from "../lib/api.js";
import { Panel, PanelHeader } from "./Panel.js";

interface Props {
  onClose: () => void;
  initialAirport?: string;
  onAirportChange?: (icao: string) => void;
}

interface AirportOption {
  icao: string;
  label: string;
}

// Same 5 Puget Sound regional fields as TrafficVolumePanel — see docs/SPEC.md §3.
export const AIRPORT_OPTIONS: AirportOption[] = [
  { icao: "KSEA", label: "KSEA — Sea-Tac Intl" },
  { icao: "KPAE", label: "KPAE — Paine Field" },
  { icao: "KBFI", label: "KBFI — Boeing Field" },
  { icao: "KRNT", label: "KRNT — Renton Municipal" },
  { icao: "KTIW", label: "KTIW — Tacoma Narrows" },
];

// Polled rather than cached — a board reflects "right now", unlike the
// traffic/noise panels' slower-changing aggregates.
const REFRESH_MS = 60_000;

function formatClock(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function statusStyle(status: string | null): string {
  const s = status?.toLowerCase() ?? "";
  if (s.includes("cancel")) return "text-red-600";
  if (s.includes("delay")) return "text-amber-600";
  if (s.includes("depart") || s.includes("land") || s.includes("arriv")) return "text-gray-400";
  return "text-sky-700";
}

function BoardRow({ flight, direction }: { flight: AirportBoardFlight; direction: AirportBoardDirection }) {
  const otherLabel = flight.other.iata ?? flight.other.icao ?? flight.other.name ?? "?";
  return (
    <div className="flex items-center gap-2 border-b border-gray-100 py-1.5 text-sm last:border-b-0">
      <span className="w-14 shrink-0 tabular-nums text-gray-700">
        {formatClock(flight.revisedTime ?? flight.scheduledTime)}
      </span>
      <span className="w-14 shrink-0 font-medium text-gray-900">{otherLabel}</span>
      <span className="min-w-0 flex-1 truncate text-gray-500" title={flight.other.name ?? undefined}>
        {flight.airlineName ?? flight.callSign}
        {flight.flightNumber ? ` ${flight.flightNumber}` : ""}
      </span>
      <span className={`shrink-0 text-xs capitalize ${statusStyle(flight.status)}`}>
        {flight.status ?? (direction === "departure" ? "scheduled" : "scheduled")}
      </span>
    </div>
  );
}

export function AirportBoardPanel({ onClose, initialAirport, onAirportChange }: Props) {
  const isValidAirport = initialAirport && AIRPORT_OPTIONS.some((opt) => opt.icao === initialAirport);
  const [airport, setAirport] = useState(isValidAirport ? initialAirport : AIRPORT_OPTIONS[0].icao);
  const [direction, setDirection] = useState<AirportBoardDirection>("departure");

  function selectAirport(next: string) {
    setAirport(next);
    onAirportChange?.(next);
  }

  const [departures, setDepartures] = useState<AirportBoardFlight[] | null>(null);
  const [arrivals, setArrivals] = useState<AirportBoardFlight[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    function load() {
      api
        .getAirportBoard(airport)
        .then((data) => {
          if (cancelled) return;
          setDepartures(data.departures);
          setArrivals(data.arrivals);
          setError(null);
        })
        .catch((err) => {
          if (!cancelled) setError(err.message);
        });
    }

    setDepartures(null);
    setArrivals(null);
    setError(null);
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [airport]);

  const flights = direction === "departure" ? departures : arrivals;

  // Board rows span the AeroDataBox window's full ~3h-past-to-9h-future
  // range (see docs/SPEC.md §12), so opening the panel would otherwise land
  // on already-departed/landed flights from hours ago. Jump to "now" by
  // default — the first still-upcoming row — once per (airport, direction)
  // selection, so it doesn't fight a user who's deliberately scrolled up to
  // see earlier flights while a background poll refreshes the data.
  const listRef = useRef<HTMLDivElement>(null);
  const scrolledToNowRef = useRef(false);

  useEffect(() => {
    scrolledToNowRef.current = false;
  }, [airport, direction]);

  useEffect(() => {
    if (scrolledToNowRef.current || !flights || flights.length === 0 || !listRef.current) return;
    scrolledToNowRef.current = true;

    const now = Date.now();
    const upcomingIndex = flights.findIndex((f) => {
      const t = f.revisedTime ?? f.scheduledTime;
      return t ? new Date(t).getTime() >= now : false;
    });
    // -1 (everything already in the past) or 0 (nothing past to skip) both
    // mean there's no scrolling to do.
    if (upcomingIndex <= 0) return;

    const row = listRef.current.children[upcomingIndex] as HTMLElement | undefined;
    if (row) listRef.current.scrollTop = row.offsetTop;
  }, [flights]);

  return (
    <Panel className="w-[420px] p-4">
      <PanelHeader
        title="Airport board"
        subtitle="Live departures and arrivals for each regional field"
        onClose={onClose}
      />

      <div className="mt-3 flex gap-2">
        <select
          value={airport}
          onChange={(e) => selectAirport(e.target.value)}
          className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
        >
          {AIRPORT_OPTIONS.map((opt) => (
            <option key={opt.icao} value={opt.icao}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-2 flex rounded-md bg-gray-100 p-0.5 text-sm">
        {(["departure", "arrival"] as const).map((d) => (
          <button
            key={d}
            onClick={() => setDirection(d)}
            className={`flex-1 rounded px-2 py-1 capitalize transition-colors ${
              direction === d ? "bg-white font-medium text-gray-900 shadow-sm" : "text-gray-500"
            }`}
          >
            {d}s
          </button>
        ))}
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {!error && (
        <div className="mt-3">
          <div className="flex items-center gap-2 pb-1 text-[11px] uppercase tracking-wide text-gray-400">
            <span className="w-14 shrink-0">Time</span>
            <span className="w-14 shrink-0">{direction === "departure" ? "To" : "From"}</span>
            <span className="min-w-0 flex-1">Flight</span>
            <span className="shrink-0">Status</span>
          </div>

          {flights === null && <p className="py-4 text-center text-sm text-gray-400">Loading…</p>}
          {flights !== null && flights.length === 0 && (
            <p className="py-4 text-center text-sm text-gray-400">
              No {direction}s in the current board window.
            </p>
          )}
          {flights !== null && flights.length > 0 && (
            <div ref={listRef} className="max-h-80 overflow-y-auto">
              {flights.map((f) => (
                <BoardRow key={`${f.callSign}-${f.scheduledTime}`} flight={f} direction={direction} />
              ))}
            </div>
          )}
        </div>
      )}

      <p className="mt-3 border-t border-gray-100 pt-2 text-[11px] text-gray-400">
        Schedule data from AeroDataBox. Empty if the field's live-schedule integration isn't configured
        for this deployment.
      </p>
    </Panel>
  );
}
