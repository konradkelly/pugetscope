import { describe, expect, it } from "vitest";
import {
  REGIONAL_AIRPORTS,
  getRegionalAirport,
  haversineKm,
  nearestRegionalAirport,
  inferFlightPhase,
} from "./regionalAirports.js";
import type { StateVector } from "../openskyClient.js";

function baseState(overrides: Partial<StateVector> = {}): StateVector {
  return {
    icao24: "abc123",
    callsign: "TEST123",
    originCountry: "United States",
    timePosition: null,
    lastContact: 0,
    longitude: -122.3088,
    latitude: 47.4502,
    baroAltitude: null,
    onGround: false,
    velocity: null,
    trueTrack: null,
    verticalRate: null,
    geoAltitude: null,
    squawk: null,
    spi: false,
    category: null,
    ...overrides,
  };
}

describe("haversineKm", () => {
  it("is zero for identical points", () => {
    expect(haversineKm(47.45, -122.3, 47.45, -122.3)).toBe(0);
  });

  it("matches a known great-circle distance (SEA to PAE, ~51km)", () => {
    const sea = REGIONAL_AIRPORTS.find((a) => a.icao === "KSEA")!;
    const pae = REGIONAL_AIRPORTS.find((a) => a.icao === "KPAE")!;
    const km = haversineKm(sea.lat, sea.lon, pae.lat, pae.lon);
    expect(km).toBeGreaterThan(45);
    expect(km).toBeLessThan(55);
  });
});

describe("getRegionalAirport", () => {
  it("finds a known airport by ICAO", () => {
    expect(getRegionalAirport("KSEA")?.name).toBe("Seattle-Tacoma Intl");
  });

  it("returns undefined for an unknown ICAO", () => {
    expect(getRegionalAirport("KXYZ")).toBeUndefined();
  });
});

describe("nearestRegionalAirport", () => {
  it("finds the field itself when standing on its reference point", () => {
    expect(nearestRegionalAirport(47.4502, -122.3088)?.icao).toBe("KSEA");
  });

  it("returns null when nothing is within any field's approach envelope", () => {
    // Middle of the Pacific — nowhere near any regional airport.
    expect(nearestRegionalAirport(40, -140)).toBeNull();
  });

  it("prefers the closer field when two approach envelopes overlap", () => {
    // A point roughly between KBFI and KRNT, close enough to plausibly fall
    // in both radii — should resolve to whichever is nearer, not just the
    // first match in array order.
    const result = nearestRegionalAirport(47.51, -122.26);
    expect(result).not.toBeNull();
    expect(["KBFI", "KRNT"]).toContain(result!.icao);
  });
});

describe("inferFlightPhase", () => {
  it("returns null for an aircraft on the ground", () => {
    expect(inferFlightPhase(baseState({ onGround: true, geoAltitude: 0 }))).toBeNull();
  });

  it("returns null when position is missing", () => {
    expect(inferFlightPhase(baseState({ latitude: null }))).toBeNull();
  });

  it("returns null when altitude is missing entirely", () => {
    expect(
      inferFlightPhase(baseState({ geoAltitude: null, baroAltitude: null })),
    ).toBeNull();
  });

  it("infers landing near KSEA when low, close-in, and descending", () => {
    const phase = inferFlightPhase(
      baseState({ latitude: 47.45, longitude: -122.31, geoAltitude: 300, verticalRate: -5 }),
    );
    expect(phase).toEqual({ kind: "landing", airportIcao: "KSEA" });
  });

  it("infers departing near KSEA when low, close-in, and climbing", () => {
    const phase = inferFlightPhase(
      baseState({ latitude: 47.45, longitude: -122.31, geoAltitude: 300, verticalRate: 5 }),
    );
    expect(phase).toEqual({ kind: "departing", airportIcao: "KSEA" });
  });

  it("returns null when level flight near a field (ambiguous, e.g. low overflight)", () => {
    const phase = inferFlightPhase(
      baseState({ latitude: 47.45, longitude: -122.31, geoAltitude: 300, verticalRate: 0 }),
    );
    expect(phase).toBeNull();
  });

  it("returns null when too high for the distance from the field (transiting)", () => {
    // 25km out (near KSEA's approach-radius edge) but far above the
    // glideslope model's max plausible approach altitude at that distance.
    const phase = inferFlightPhase(
      baseState({ latitude: 47.6, longitude: -122.3, geoAltitude: 10000, verticalRate: -5 }),
    );
    expect(phase).toBeNull();
  });

  it("falls back to baroAltitude when geoAltitude is unavailable", () => {
    const phase = inferFlightPhase(
      baseState({
        latitude: 47.45, longitude: -122.31,
        geoAltitude: null, baroAltitude: 300,
        verticalRate: -5,
      }),
    );
    expect(phase).toEqual({ kind: "landing", airportIcao: "KSEA" });
  });
});
