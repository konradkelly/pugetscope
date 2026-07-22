import { useEffect, useRef, useState } from "react";
import {
  api,
  type AirportTraffic,
  type TrafficDay,
  type TrafficDayOfWeek,
  type TrafficHour,
} from "../lib/api.js";

interface Props {
  onClose: () => void;
}

interface AirportOption {
  icao: string;
  label: string;
}

// See docs/SPEC.md §3 — the 5 Puget Sound regional fields tracked by ingestion.
const AIRPORT_OPTIONS: AirportOption[] = [
  { icao: "KSEA", label: "KSEA — Sea-Tac Intl" },
  { icao: "KPAE", label: "KPAE — Paine Field" },
  { icao: "KBFI", label: "KBFI — Boeing Field" },
  { icao: "KRNT", label: "KRNT — Renton Municipal" },
  { icao: "KTIW", label: "KTIW — Tacoma Narrows" },
];

// Not a real ICAO code — a pseudo-airport value selecting the region-wide
// endpoint instead of a per-airport one. Kept out of AIRPORT_OPTIONS itself
// since that array also drives the per-airport comparison bars, which have
// no "ALL" row.
const REGION_ICAO = "ALL";
const SELECT_OPTIONS: AirportOption[] = [
  ...AIRPORT_OPTIONS,
  { icao: REGION_ICAO, label: "All airports — Region-wide" },
];

const DAY_OPTIONS = [1, 7, 14, 30, 60, 90];
const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21];
const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// "Today" refetches on an interval below rather than going through the
// no-TTL caches, since — unlike the 7-90d windows — this count keeps
// accumulating throughout the day and a stale cached value would mislead.
const TODAY_REFRESH_MS = 60_000;

function dayLabel(days: number): string {
  return days === 1 ? "Today" : `${days}d`;
}

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

// "YYYY-MM-DD" -> "M/D", for compact x-axis labels on the daily trend.
function dateLabel(date: string): string {
  const [, month, day] = date.split("-");
  return `${Number(month)}/${Number(day)}`;
}

// Sparse tick indices for an n-bar axis (always includes the first and last
// bar) — avoids cramming up to 90 date labels into a 460px-wide chart.
function pickTicks(n: number, maxTicks = 6): number[] {
  if (n <= maxTicks) return Array.from({ length: n }, (_, i) => i);
  const step = (n - 1) / (maxTicks - 1);
  const ticks = Array.from({ length: maxTicks }, (_, i) => Math.round(i * step));
  return Array.from(new Set(ticks));
}

export function TrafficVolumePanel({ onClose }: Props) {
  const [airport, setAirport] = useState(AIRPORT_OPTIONS[0].icao);
  const [days, setDays] = useState(30);

  const [totals, setTotals] = useState<AirportTraffic[] | null>(null);
  const [totalsError, setTotalsError] = useState<string | null>(null);

  const [hourly, setHourly] = useState<TrafficHour[] | null>(null);
  const [dayOfWeek, setDayOfWeek] = useState<TrafficDayOfWeek[] | null>(null);
  const [daily, setDaily] = useState<TrafficDay[] | null>(null);
  const [volumeError, setVolumeError] = useState<string | null>(null);

  const [hoveredHour, setHoveredHour] = useState<number | null>(null);
  const [hoveredDow, setHoveredDow] = useState<number | null>(null);
  const [hoveredDayIdx, setHoveredDayIdx] = useState<number | null>(null);

  const [todayFlights, setTodayFlights] = useState<number | null>(null);
  const [todayError, setTodayError] = useState<string | null>(null);

  const isRegion = airport === REGION_ICAO;

  const totalsCache = useRef(new Map<number, AirportTraffic[]>());
  const volumeCache = useRef(new Map<string, { hourly: TrafficHour[]; dayOfWeek: TrafficDayOfWeek[] }>());
  const regionCache = useRef(new Map<number, { hourly: TrafficHour[]; daily: TrafficDay[] }>());

  useEffect(() => {
    const cached = totalsCache.current.get(days);
    if (cached) {
      setTotals(cached);
      setTotalsError(null);
      return;
    }

    let cancelled = false;
    setTotals(null);
    setTotalsError(null);
    api
      .getAirportTrafficTotals(days)
      .then((data) => {
        if (cancelled) return;
        totalsCache.current.set(days, data.airports);
        setTotals(data.airports);
      })
      .catch((err) => {
        if (!cancelled) setTotalsError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  useEffect(() => {
    if (isRegion) {
      const cached = regionCache.current.get(days);
      if (cached) {
        setHourly(cached.hourly);
        setDaily(cached.daily);
        setDayOfWeek(null);
        setVolumeError(null);
        return;
      }

      let cancelled = false;
      setHourly(null);
      setDaily(null);
      setDayOfWeek(null);
      setVolumeError(null);
      api
        .getRegionTraffic(days)
        .then((data) => {
          if (cancelled) return;
          regionCache.current.set(days, { hourly: data.hourly, daily: data.daily });
          setHourly(data.hourly);
          setDaily(data.daily);
        })
        .catch((err) => {
          if (!cancelled) setVolumeError(err.message);
        });
      return () => {
        cancelled = true;
      };
    }

    const key = `${airport}:${days}`;
    const cached = volumeCache.current.get(key);
    if (cached) {
      setHourly(cached.hourly);
      setDayOfWeek(cached.dayOfWeek);
      setDaily(null);
      setVolumeError(null);
      return;
    }

    let cancelled = false;
    setHourly(null);
    setDayOfWeek(null);
    setDaily(null);
    setVolumeError(null);
    api
      .getTrafficVolume(airport, days)
      .then((data) => {
        if (cancelled) return;
        volumeCache.current.set(key, { hourly: data.hourly, dayOfWeek: data.dayOfWeek });
        setHourly(data.hourly);
        setDayOfWeek(data.dayOfWeek);
      })
      .catch((err) => {
        if (!cancelled) setVolumeError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [airport, days, isRegion]);

  // Independent of the `days` filter above — always reflects the selected
  // airport's (or the whole region's) rolling last-24h count, polled rather
  // than cached.
  useEffect(() => {
    let cancelled = false;

    function load() {
      const request = isRegion ? api.getRegionTraffic(1) : api.getTrafficVolume(airport, 1);
      request
        .then((data) => {
          if (cancelled) return;
          setTodayFlights(data.totalFlights);
          setTodayError(null);
        })
        .catch((err) => {
          if (!cancelled) setTodayError(err.message);
        });
    }

    load();
    const interval = setInterval(load, TODAY_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [airport, isRegion]);

  const safeHours = hourly ?? [];
  const maxHourly = niceMax(Math.max(1, ...safeHours.map((h) => h.flights)));
  const peakHour = safeHours.reduce<TrafficHour | null>(
    (max, h) => (max === null || h.flights > max.flights ? h : max),
    null,
  );
  const hovered = hoveredHour !== null ? safeHours.find((h) => h.hour === hoveredHour) : undefined;

  const safeDow = dayOfWeek ?? [];
  const maxDow = niceMax(Math.max(1, ...safeDow.map((d) => d.flights)));
  const hoveredDowRow = hoveredDow !== null ? safeDow.find((d) => d.dow === hoveredDow) : undefined;

  const safeDaily = daily ?? [];
  const maxDaily = niceMax(Math.max(1, ...safeDaily.map((d) => d.flights)));
  const dailyTicks = pickTicks(safeDaily.length);
  const hoveredDay = hoveredDayIdx !== null ? safeDaily[hoveredDayIdx] : undefined;

  const maxAirportFlights = niceMax(Math.max(1, ...(totals ?? []).map((a) => a.flights)));

  return (
    <div className="absolute bottom-12 right-4 w-[460px] rounded-lg bg-white/95 p-4 shadow-lg backdrop-blur">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold leading-tight">Traffic volume</h2>
          <p className="text-sm text-gray-500">Aircraft near each field, by hour, day, and airport</p>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-700" aria-label="Close">
          ✕
        </button>
      </div>

      <div className="mt-3 flex gap-2">
        <select
          value={airport}
          onChange={(e) => setAirport(e.target.value)}
          className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
        >
          {SELECT_OPTIONS.map((opt) => (
            <option key={opt.icao} value={opt.icao}>
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
              {dayLabel(d)}
            </option>
          ))}
        </select>
      </div>

      {/* Live "today" stat tile — independent of the days filter above */}
      <div className="mt-3 rounded-md bg-sky-50 px-3 py-2">
        {todayError ? (
          <p className="text-sm text-red-600">{todayError}</p>
        ) : (
          <>
            <p className="text-2xl font-semibold leading-tight text-sky-900">
              {todayFlights === null ? "—" : todayFlights.toLocaleString()}
            </p>
            <p className="text-xs text-gray-500">
              {isRegion ? "flights today, all airports, last 24h" : `flights today at ${airport}, last 24h`}
            </p>
          </>
        )}
      </div>

      {/* Airport comparison — the "split by airport" view */}
      {totalsError && <p className="mt-2 text-sm text-red-600">{totalsError}</p>}
      {!totalsError && (
        <div className="mt-3 space-y-1">
          {(totals ?? AIRPORT_OPTIONS.map((o) => ({ icao: o.icao, iata: "", name: "", flights: 0 }))).map((a) => {
            const isSelected = a.icao === airport;
            const widthPct = totals ? Math.max((a.flights / maxAirportFlights) * 100, a.flights > 0 ? 2 : 0) : 0;
            return (
              <button
                key={a.icao}
                onClick={() => setAirport(a.icao)}
                className="flex w-full items-center gap-2 text-left"
              >
                <span className={`w-12 shrink-0 text-xs ${isSelected ? "font-semibold text-gray-900" : "text-gray-500"}`}>
                  {a.icao}
                </span>
                <span className="h-4 flex-1 overflow-hidden rounded bg-gray-100">
                  <span
                    className={`block h-full rounded transition-all ${isSelected ? "bg-sky-600" : "bg-sky-300"}`}
                    style={{ width: `${widthPct}%` }}
                  />
                </span>
                <span className="w-10 shrink-0 text-right text-xs text-gray-500">
                  {totals ? a.flights.toLocaleString() : ""}
                </span>
              </button>
            );
          })}
          <p className="pt-1 text-[11px] text-gray-400">
            Counts any aircraft within each field's approach radius, not confirmed landings —
            traffic bound for KSEA can inflate nearby small-field counts (e.g. Renton, Boeing Field).
          </p>
        </div>
      )}

      {volumeError && <p className="mt-3 text-sm text-red-600">{volumeError}</p>}

      {/* Hour-of-day histogram */}
      {!volumeError && (
        <div className="mt-4 border-t border-gray-100 pt-3">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-gray-500">
              {hourly ? "Flights by hour of day, Pacific time" : "Loading…"}
            </span>
            {peakHour && peakHour.flights > 0 && (
              <span className="text-gray-500">busiest at {hourLabel(peakHour.hour)}</span>
            )}
          </div>

          <div className="relative mt-3 h-24">
            <div className="absolute inset-x-0 top-0 border-t border-gray-100" />
            <div className="absolute inset-x-0 top-1/2 border-t border-gray-100" />
            <div className="absolute inset-x-0 bottom-0 border-t border-gray-300" />

            <div className="relative flex h-full gap-[2px]">
              {Array.from({ length: 24 }, (_, hour) => {
                const row = safeHours.find((h) => h.hour === hour);
                const value = row?.flights ?? 0;
                const heightPct = maxHourly > 0 ? (value / maxHourly) * 100 : 0;
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
                {hovered.flights} flight{hovered.flights === 1 ? "" : "s"}
              </>
            ) : (
              <>&nbsp;</>
            )}
          </div>
        </div>
      )}

      {/* Day-of-week pattern (per-airport) or daily trend (region-wide) */}
      {!volumeError && isRegion && (
        <div className="mt-4 border-t border-gray-100 pt-3">
          <span className="text-sm text-gray-500">
            {daily ? "Flights per day, Pacific time" : "Loading…"}
          </span>

          <div className="relative mt-3 h-20">
            <div className="absolute inset-x-0 bottom-0 border-t border-gray-300" />
            <div className="relative flex h-full gap-px">
              {safeDaily.map((d, idx) => {
                const heightPct = maxDaily > 0 ? (d.flights / maxDaily) * 100 : 0;
                const barHeightPct = Math.max(heightPct, d.flights > 0 ? 3 : 0);
                const isToday = idx === safeDaily.length - 1;
                return (
                  <div
                    key={d.date}
                    className="group relative h-full flex-1"
                    onMouseEnter={() => setHoveredDayIdx(idx)}
                    onMouseLeave={() => setHoveredDayIdx(null)}
                  >
                    <div
                      className={`absolute bottom-0 w-full rounded-t transition-opacity group-hover:opacity-80 ${
                        isToday ? "bg-sky-300" : "bg-sky-600"
                      }`}
                      style={{ height: `${barHeightPct}%` }}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div className="relative mt-1 h-3 text-[10px] text-gray-400">
            {dailyTicks.map((idx) => (
              <span
                key={idx}
                className="absolute -translate-x-1/2"
                style={{ left: `${((idx + 0.5) / safeDaily.length) * 100}%` }}
              >
                {safeDaily[idx] ? dateLabel(safeDaily[idx].date) : ""}
              </span>
            ))}
          </div>

          <div
            className={`mt-2 rounded bg-sky-50 px-2 py-1 text-xs text-gray-700 transition-opacity duration-300 ease-out ${
              hoveredDay ? "opacity-100" : "opacity-0"
            }`}
          >
            {hoveredDay ? (
              <>
                <span className="font-medium">{dateLabel(hoveredDay.date)}</span>
                {": "}
                {hoveredDay.flights} flight{hoveredDay.flights === 1 ? "" : "s"}
                {hoveredDayIdx === safeDaily.length - 1 ? " (so far today)" : ""}
              </>
            ) : (
              <>&nbsp;</>
            )}
          </div>
        </div>
      )}

      {!volumeError && !isRegion && (
        <div className="mt-4 border-t border-gray-100 pt-3">
          <span className="text-sm text-gray-500">
            {dayOfWeek ? "Flights by day of week" : "Loading…"}
          </span>

          <div className="relative mt-3 h-20">
            <div className="absolute inset-x-0 bottom-0 border-t border-gray-300" />
            <div className="relative flex h-full gap-2">
              {safeDow.map((d) => {
                const heightPct = maxDow > 0 ? (d.flights / maxDow) * 100 : 0;
                const barHeightPct = Math.max(heightPct, d.flights > 0 ? 3 : 0);
                return (
                  <div
                    key={d.dow}
                    className="group relative h-full flex-1"
                    onMouseEnter={() => setHoveredDow(d.dow)}
                    onMouseLeave={() => setHoveredDow(null)}
                  >
                    <div
                      className="absolute bottom-0 w-full rounded-t bg-sky-600 transition-opacity group-hover:opacity-80"
                      style={{ height: `${barHeightPct}%` }}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-1 flex gap-2 text-[10px] text-gray-400">
            {DOW_LABELS.map((label) => (
              <span key={label} className="flex-1 text-center">
                {label}
              </span>
            ))}
          </div>

          <div
            className={`mt-2 rounded bg-sky-50 px-2 py-1 text-xs text-gray-700 transition-opacity duration-300 ease-out ${
              hoveredDowRow ? "opacity-100" : "opacity-0"
            }`}
          >
            {hoveredDowRow ? (
              <>
                <span className="font-medium">{DOW_LABELS[hoveredDowRow.dow]}</span>
                {": "}
                {hoveredDowRow.flights} flight{hoveredDowRow.flights === 1 ? "" : "s"} over the last {days}d
              </>
            ) : (
              <>&nbsp;</>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
