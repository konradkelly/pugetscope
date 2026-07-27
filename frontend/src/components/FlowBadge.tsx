import { useEffect, useState } from "react";
import { api, type AirportFlow } from "../lib/api.js";

// How often each airport's reading is re-fetched — flow direction changes
// on the order of hours, not seconds, so this is deliberately slow. See
// docs/SPEC.md §15.
const REFRESH_MS = 60_000;
// How often the single visible airport rotates. Independent of REFRESH_MS:
// showing all 5 at once (tried first) made this a multi-line card that
// didn't sit well next to the single-line live/connected pill (the same
// "tall element next to a short one" alignment trap this app already hit
// once with the rail dock) — rotating keeps it a single glanceable line.
const ROTATE_MS = 10_000;

// Same 5 Puget Sound regional fields as AirportBoardPanel/TrafficVolumePanel
// — this repo's no-shared-package convention (docs/rollup-tables.md) means
// each file keeps its own small copy rather than importing a shared list.
const AIRPORTS = [
  { icao: "KSEA", iata: "SEA" },
  { icao: "KPAE", iata: "PAE" },
  { icao: "KBFI", iata: "BFI" },
  { icao: "KRNT", iata: "RNT" },
  { icao: "KTIW", iata: "TIW" },
] as const;

// Lowest-friction presentation per docs/SPEC.md §15: a small glanceable,
// no-click-required badge next to the existing live/connected status pill.
// Rotates through whichever regional fields currently have a reading rather
// than showing all 5 at once.
export function FlowBadge() {
  const [flows, setFlows] = useState<Map<string, AirportFlow>>(new Map());
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;

    function load() {
      Promise.all(AIRPORTS.map((a) => api.getAirportFlow(a.icao).catch(() => null))).then(
        (results) => {
          if (cancelled) return;
          const next = new Map<string, AirportFlow>();
          results.forEach((data, i) => {
            if (data) next.set(AIRPORTS[i].icao, data);
          });
          setFlows(next);
        },
      );
    }

    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    // Just keeps counting; the modulo against the current row count happens
    // at render time below, so a row appearing/disappearing between ticks
    // (a field's window emptying out, say) can't leave this pointed at a
    // stale/out-of-range entry.
    const interval = setInterval(() => setIndex((i) => i + 1), ROTATE_MS);
    return () => clearInterval(interval);
  }, []);

  // Only airports with something worth showing (a populated rolling window)
  // are eligible to rotate through — an "unknown" entry would just be noise.
  const rows = AIRPORTS.map((a) => ({ ...a, data: flows.get(a.icao) })).filter(
    (a): a is typeof a & { data: AirportFlow } =>
      !!a.data && a.data.confidence !== "unknown" && !!a.data.flow && !!a.data.runway,
  );

  if (rows.length === 0) return null;

  const { iata, data } = rows[index % rows.length];

  return (
    <div
      className="whitespace-nowrap rounded bg-white/90 px-3 py-1 text-xs text-gray-700 shadow"
      title={`Inferred from ${data.sampleSize} recent landing${data.sampleSize === 1 ? "" : "s"}${
        data.confidence === "low" ? " — low confidence" : ""
      } — not an official ATIS report`}
    >
      {iata}: {data.flow === "north" ? "North" : "South"} Flow (rwy {data.runway})
    </div>
  );
}
