import { beforeEach, describe, expect, it } from "vitest";
import { recordFlowObservations, computeFlowReadings } from "./flowDirection.js";
import type { StateVector } from "../openskyClient.js";

function landingAt(
  icao: "KSEA" | "KPAE" | "KBFI" | "KRNT" | "KTIW",
  trueTrack: number,
  overrides: Partial<StateVector> = {},
): StateVector {
  // Coordinates/altitude/verticalRate chosen so regionalAirports.ts's
  // inferFlightPhase() classifies this as "landing" at the given field —
  // see its own tests for the geometry this depends on.
  const coords: Record<string, { lat: number; lon: number }> = {
    KSEA: { lat: 47.45, lon: -122.31 },
    KPAE: { lat: 47.9063, lon: -122.2816 },
    KBFI: { lat: 47.53, lon: -122.3019 },
    KRNT: { lat: 47.4931, lon: -122.216 },
    KTIW: { lat: 47.2679, lon: -122.5776 },
  };
  return {
    icao24: "abc123",
    callsign: "TEST123",
    originCountry: "United States",
    timePosition: null,
    lastContact: 0,
    longitude: coords[icao].lon,
    latitude: coords[icao].lat,
    baroAltitude: null,
    onGround: false,
    velocity: null,
    trueTrack,
    verticalRate: -5,
    geoAltitude: 300,
    squawk: null,
    spi: false,
    category: null,
    ...overrides,
  };
}

// flowDirection.ts's observation buffer is module-level state, not
// reset between test files — every test below uses its own now/window,
// but tests within this file still share the buffer, so each one only
// asserts on the airport(s) it itself fed observations into.
describe("recordFlowObservations / computeFlowReadings", () => {
  it("reports 'unknown' with zero samples for an airport with no recent observations", () => {
    const readings = computeFlowReadings(Date.now());
    // KTIW is never fed observations by earlier tests in this suite (KSEA/
    // KPAE/KBFI/KRNT are), so it should still read as unknown here.
    expect(readings.get("KTIW")).toMatchObject({ flow: null, confidence: "unknown", sampleSize: 0 });
  });

  it("votes 'north' flow from a majority of runway-34-aligned (heading ~0) landings at KSEA", () => {
    const now = Date.now();
    // KSEA runwayHeadings are [180, 0] ("16","34") — headings near 0 bucket
    // to index 1 ("34"), which flowFromHeading maps to "north".
    recordFlowObservations(
      [landingAt("KSEA", 2), landingAt("KSEA", 358), landingAt("KSEA", 1)],
      now,
    );
    const readings = computeFlowReadings(now);
    const ksea = readings.get("KSEA")!;
    expect(ksea.flow).toBe("north");
    expect(ksea.runway).toBe("34");
    expect(ksea.sampleSize).toBe(3);
    expect(ksea.confidence).toBe("high"); // 3/3 samples, 100% share >= 65%
  });

  it("votes 'south' flow from runway-16-aligned (heading ~180) landings and reports low confidence on a narrow majority", () => {
    const now = Date.now();
    // 3 votes for ~180 (south), 2 votes for ~0 (north) -> share 3/5 = 60%,
    // below HIGH_CONFIDENCE_MIN_SHARE (65%) -> "low" despite sampleSize >= 3.
    recordFlowObservations(
      [
        landingAt("KPAE", 179), landingAt("KPAE", 181), landingAt("KPAE", 180),
        landingAt("KPAE", 2), landingAt("KPAE", 358),
      ],
      now,
    );
    const readings = computeFlowReadings(now);
    const kpae = readings.get("KPAE")!;
    expect(kpae.flow).toBe("south");
    expect(kpae.runway).toBe("16");
    expect(kpae.sampleSize).toBe(5);
    expect(kpae.confidence).toBe("low");
  });

  it("reports 'unknown' when only 1-2 samples exist even with unanimous agreement (below the sample-count floor)", () => {
    const now = Date.now();
    recordFlowObservations([landingAt("KBFI", 150)], now);
    const readings = computeFlowReadings(now);
    const kbfi = readings.get("KBFI")!;
    expect(kbfi.sampleSize).toBe(1);
    expect(kbfi.confidence).toBe("low"); // unanimous but below HIGH_CONFIDENCE_MIN_SAMPLES
  });

  it("prunes observations older than the rolling window out of the vote", () => {
    const windowMs = 18 * 60 * 1000;
    const past = Date.now() - 1_000_000_000; // arbitrary fixed anchor, far enough in the past
    recordFlowObservations([landingAt("KRNT", 174)], past);
    // Well past the window relative to the observation's own timestamp.
    const readings = computeFlowReadings(past + windowMs + 60_000);
    const krnt = readings.get("KRNT")!;
    expect(krnt.sampleSize).toBe(0);
    expect(krnt.confidence).toBe("unknown");
  });

  it("ignores states with a null trueTrack (can't bucket a heading that doesn't exist)", () => {
    const now = Date.now();
    const before = computeFlowReadings(now).get("KTIW")!.sampleSize;
    recordFlowObservations([landingAt("KTIW", 187, { trueTrack: null })], now);
    const after = computeFlowReadings(now).get("KTIW")!.sampleSize;
    expect(after).toBe(before);
  });

  it("ignores states that aren't inferred as landing (e.g. on the ground)", () => {
    const now = Date.now();
    const before = computeFlowReadings(now).get("KTIW")!.sampleSize;
    recordFlowObservations([landingAt("KTIW", 187, { onGround: true })], now);
    const after = computeFlowReadings(now).get("KTIW")!.sampleSize;
    expect(after).toBe(before);
  });
});
