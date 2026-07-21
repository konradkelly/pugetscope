import { useEffect, useState } from "react";
import {
  api,
  type OverflightEvent,
  type OverflightHour,
} from "../lib/api.js";

interface Props {
  onClose: () => void;
}

interface ZipOption {
  zip: string;
  label: string;
}

// Zips confirmed to have loaded boundary data and noise relevance — see docs/SPEC.md §13.
const ZIP_OPTIONS: ZipOption[] = [
  { zip: "98108", label: "98108 — Beacon Hill / Georgetown" },
  { zip: "98146", label: "98146 — Burien" },
  { zip: "98158", label: "98158 — SeaTac / Des Moines" },
  { zip: "98168", label: "98168 — Tukwila" },
  { zip: "98188", label: "98188 — SeaTac" },
  { zip: "98198", label: "98198 — Des Moines" },
];

const DAY_OPTIONS = [7, 14, 30, 60, 90];
const EVENTS_WINDOW_HOURS = 3;
const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21];

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function hourLabel(hour: number): string {
  const period = hour < 12 ? "a" : "p";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${period}`;
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function NeighborhoodAnalyticsPanel({ onClose }: Props) {
  const [zip, setZip] = useState(ZIP_OPTIONS[0].zip);
  const [days, setDays] = useState(30);

  const [hours, setHours] = useState<OverflightHour[] | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const [events, setEvents] = useState<OverflightEvent[] | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const [hoveredHour, setHoveredHour] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHours(null);
    setSummaryError(null);
    api
      .getOverflightSummary(zip, days)
      .then((data) => {
        if (!cancelled) setHours(data.hours);
      })
      .catch((err) => {
        if (!cancelled) setSummaryError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [zip, days]);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setEventsError(null);
    const to = new Date();
    const from = new Date(to.getTime() - EVENTS_WINDOW_HOURS * 60 * 60 * 1000);
    api
      .getOverflightEvents(zip, from.toISOString(), to.toISOString())
      .then((data) => {
        if (!cancelled) setEvents(data.events);
      })
      .catch((err) => {
        if (!cancelled) setEventsError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [zip]);

  const safeHours = hours ?? [];
  const maxOverflights = niceMax(Math.max(1, ...safeHours.map((h) => h.overflights)));
  const peakHour = safeHours.reduce<OverflightHour | null>(
    (max, h) => (max === null || h.overflights > max.overflights ? h : max),
    null,
  );
  const totalOverflights = safeHours.reduce((sum, h) => sum + h.overflights, 0);
  const hovered = hoveredHour !== null ? safeHours.find((h) => h.hour === hoveredHour) : undefined;

  return (
    <div className="absolute bottom-12 left-4 w-[420px] rounded-lg bg-white/95 p-4 shadow-lg backdrop-blur">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold leading-tight">Neighborhood noise</h2>
          <p className="text-sm text-gray-500">Overflights by hour of day, Pacific time</p>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-700" aria-label="Close">
          ✕
        </button>
      </div>

      <div className="mt-3 flex gap-2">
        <select
          value={zip}
          onChange={(e) => setZip(e.target.value)}
          className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
        >
          {ZIP_OPTIONS.map((opt) => (
            <option key={opt.zip} value={opt.zip}>
              {opt.label}
            </option>
          ))}
        </select>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="rounded border border-gray-300 px-2 py-1 text-sm"
        >
          {DAY_OPTIONS.map((d) => (
            <option key={d} value={d}>
              {d}d
            </option>
          ))}
        </select>
      </div>

      {summaryError && <p className="mt-2 text-sm text-red-600">{summaryError}</p>}

      {!summaryError && (
        <div className="mt-3">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-gray-500">
              {hours ? `${totalOverflights.toLocaleString()} overflights in the last ${days}d` : "Loading…"}
            </span>
            {peakHour && peakHour.overflights > 0 && (
              <span className="text-gray-500">busiest at {hourLabel(peakHour.hour)}</span>
            )}
          </div>

          <div className="relative mt-4 h-28">
            <div className="absolute inset-x-0 top-0 border-t border-gray-100" />
            <div className="absolute inset-x-0 top-1/2 border-t border-gray-100" />
            <div className="absolute inset-x-0 bottom-0 border-t border-gray-300" />

            <div className="relative flex h-full gap-[2px]">
              {Array.from({ length: 24 }, (_, hour) => {
                const row = safeHours.find((h) => h.hour === hour);
                const value = row?.overflights ?? 0;
                const heightPct = maxOverflights > 0 ? (value / maxOverflights) * 100 : 0;
                const barHeightPct = Math.max(heightPct, value > 0 ? 3 : 0);
                const isPeak = peakHour?.hour === hour && value > 0;
                return (
                  <div
                    key={hour}
                    className="group relative h-full flex-1"
                    onMouseEnter={() => setHoveredHour(hour)}
                    onMouseLeave={() => setHoveredHour(null)}
                  >
                    {isPeak && (
                      <div
                        className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-medium text-sky-700"
                        style={{ bottom: `calc(${barHeightPct}% + 4px)` }}
                      >
                        {value}
                      </div>
                    )}
                    <div
                      className="absolute bottom-0 w-full rounded-t bg-sky-600 transition-opacity group-hover:opacity-80"
                      style={{ height: `${barHeightPct}%` }}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div className="relative mt-1 h-3 text-[10px] text-gray-400">
            {HOUR_TICKS.map((hour) => (
              <span
                key={hour}
                className="absolute -translate-x-1/2"
                style={{ left: `${((hour + 0.5) / 24) * 100}%` }}
              >
                {hourLabel(hour)}
              </span>
            ))}
          </div>

          <div
            className={`mt-2 rounded bg-sky-50 px-2 py-1 text-xs text-gray-700 transition-opacity duration-300 ease-out ${
              hovered ? "opacity-100" : "opacity-0"
            }`}
          >
            {hovered ? (
              <>
                <span className="font-medium">
                  {hourLabel(hovered.hour)}–{hourLabel((hovered.hour + 1) % 24)}
                </span>
                {": "}
                {hovered.overflights} overflight{hovered.overflights === 1 ? "" : "s"}
                {hovered.avgAltitude != null && (
                  <>
                    {" "}
                    · avg {Math.round(hovered.avgAltitude)} m, min{" "}
                    {Math.round(hovered.minAltitude ?? hovered.avgAltitude)} m
                  </>
                )}
              </>
            ) : (
              // reserves the block's height so nothing shifts while it fades in/out
              <>&nbsp;</>
            )}
          </div>
        </div>
      )}

      <div className="mt-4 border-t border-gray-100 pt-3">
        <h3 className="text-sm font-semibold">Last {EVENTS_WINDOW_HOURS}h — closest passes</h3>
        {eventsError && <p className="mt-1 text-xs text-red-600">{eventsError}</p>}
        {!eventsError && events && events.length === 0 && (
          <p className="mt-1 text-xs text-gray-400">Nothing overhead recently.</p>
        )}
        {!eventsError && events && events.length > 0 && (
          <ul className="mt-1 max-h-32 space-y-1 overflow-y-auto text-xs">
            {events.slice(0, 8).map((e) => (
              <li key={e.icao24} className="flex justify-between gap-2">
                <span className="truncate text-gray-700">
                  {e.callsign?.trim() || e.icao24}
                  {e.model && <span className="text-gray-400"> · {e.model}</span>}
                </span>
                <span className="whitespace-nowrap text-gray-500">
                  {formatClock(e.recorded_at)}
                  {e.altitude != null && ` · ${Math.round(e.altitude)}m`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
