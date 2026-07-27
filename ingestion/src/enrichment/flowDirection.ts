import type { StateVector } from "../openskyClient.js";
import { REGIONAL_AIRPORTS, inferFlightPhase } from "./regionalAirports.js";

// See docs/SPEC.md §15. Arrivals only for v1 — reasoning about which
// runway-half a departure used adds ambiguity not worth it for a first pass
// (noted in the spec as a possible v1.1 refinement).

export type FlowLabel = "north" | "south";

export interface FlowReading {
  runway: string | null; // e.g. "34" — the ATIS-style runway number in use
  flow: FlowLabel | null;
  headingDeg: number | null;
  confidence: "high" | "low" | "unknown";
  sampleSize: number;
  asOf: string; // ISO
}

// ~15-20 min rolling window per docs/SPEC.md §15 — long enough that a single
// poll with zero aircraft on approach (common for the smaller GA fields)
// doesn't flap the reading to "unknown", short enough that a real flow
// change (a wind shift) is reflected within the same order of magnitude the
// spec expects for this feature ("changes on the order of hours").
const WINDOW_MS = 18 * 60 * 1000;
const HIGH_CONFIDENCE_MIN_SAMPLES = 3;
const HIGH_CONFIDENCE_MIN_SHARE = 0.65;

interface Observation {
  headingIndex: 0 | 1;
  atMs: number;
}

// In-memory only, not persisted — a service restart just means a brief
// "unknown" until fresh samples accumulate, the same class of intentionally
// ephemeral state as the frontend's own flight trails (AircraftMap.tsx's
// trailsRef), per the spec's own framing.
const observations = new Map<string, Observation[]>();

function circularDiffDeg(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function bucketHeading(trueTrack: number, headings: readonly [number, number]): 0 | 1 {
  return circularDiffDeg(trueTrack, headings[0]) <= circularDiffDeg(trueTrack, headings[1]) ? 0 : 1;
}

// Puget Sound's regional runways all happen to be roughly north-south
// aligned (see REGIONAL_AIRPORTS), so "closer to true north or true south"
// is a single rule that generalizes across every field rather than needing
// a per-airport north/south mapping.
function flowFromHeading(headingDeg: number): FlowLabel {
  return circularDiffDeg(headingDeg, 0) <= circularDiffDeg(headingDeg, 180) ? "north" : "south";
}

/**
 * Feeds this poll's landing-phase observations into each regional airport's
 * rolling buffer. Call once per poll with the full (unfiltered) state list —
 * reuses regionalAirports.ts's own phase detection, just also classifying
 * the landing aircraft's trueTrack against the field's runway headings. See
 * docs/SPEC.md §15.
 */
export function recordFlowObservations(states: StateVector[], now = Date.now()): void {
  for (const state of states) {
    if (state.trueTrack === null) continue;

    const phase = inferFlightPhase(state);
    if (!phase || phase.kind !== "landing") continue;

    const airport = REGIONAL_AIRPORTS.find((a) => a.icao === phase.airportIcao);
    if (!airport) continue;

    const bucket = observations.get(airport.icao) ?? [];
    bucket.push({ headingIndex: bucketHeading(state.trueTrack, airport.runwayHeadings), atMs: now });
    observations.set(airport.icao, bucket);
  }
}

/**
 * Majority-votes each regional airport's rolling buffer (pruning anything
 * outside the window first) into a single flow reading per field. Called
 * once per poll, after recordFlowObservations for that same poll.
 */
export function computeFlowReadings(now = Date.now()): Map<string, FlowReading> {
  const readings = new Map<string, FlowReading>();
  const asOf = new Date(now).toISOString();

  for (const airport of REGIONAL_AIRPORTS) {
    const pruned = (observations.get(airport.icao) ?? []).filter((o) => now - o.atMs <= WINDOW_MS);
    observations.set(airport.icao, pruned);

    if (pruned.length === 0) {
      readings.set(airport.icao, {
        runway: null, flow: null, headingDeg: null, confidence: "unknown", sampleSize: 0, asOf,
      });
      continue;
    }

    const votes: [number, number] = [0, 0];
    for (const o of pruned) votes[o.headingIndex]++;
    const winner: 0 | 1 = votes[0] >= votes[1] ? 0 : 1;
    const share = votes[winner] / pruned.length;

    const confidence: FlowReading["confidence"] =
      pruned.length >= HIGH_CONFIDENCE_MIN_SAMPLES && share >= HIGH_CONFIDENCE_MIN_SHARE ? "high" : "low";
    const headingDeg = airport.runwayHeadings[winner];

    readings.set(airport.icao, {
      runway: airport.runwayLabels[winner],
      flow: flowFromHeading(headingDeg),
      headingDeg,
      confidence,
      sampleSize: pruned.length,
      asOf,
    });
  }

  return readings;
}
