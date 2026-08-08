import { describe, expect, it } from "vitest";
import { matchWatches, type LiveAircraft } from "./matching.js";
import type { CachedWatch } from "./cache.js";

function aircraft(overrides: Partial<LiveAircraft> = {}): LiveAircraft {
  return {
    icao24: "abc123",
    callsign: "TEST123",
    latitude: 47.45,
    longitude: -122.31,
    geoAltitude: 1000,
    baroAltitude: 1000,
    ...overrides,
  };
}

function geofenceWatch(overrides: Partial<CachedWatch> = {}): CachedWatch {
  return {
    id: 1,
    deviceId: "device-1",
    kind: "geofence",
    label: "Home",
    lat: 47.45,
    lon: -122.31,
    radiusM: 5000,
    maxAltitudeM: null,
    matchValue: null,
    lastTriggeredAtMs: null,
    subscriptions: [],
    ...overrides,
  };
}

function callsignWatch(overrides: Partial<CachedWatch> = {}): CachedWatch {
  return {
    id: 2,
    deviceId: "device-1",
    kind: "callsign",
    label: "N12345",
    lat: null,
    lon: null,
    radiusM: null,
    maxAltitudeM: null,
    matchValue: "TEST123",
    lastTriggeredAtMs: null,
    subscriptions: [],
    ...overrides,
  };
}

describe("matchWatches — geofence watches", () => {
  it("matches an aircraft within the radius", () => {
    const matches = matchWatches([aircraft()], [geofenceWatch()]);
    expect(matches).toHaveLength(1);
    expect(matches[0].watch.id).toBe(1);
  });

  it("does not match an aircraft outside the radius", () => {
    // ~1 degree of longitude at this latitude is on the order of 75km —
    // far outside a 5km radius.
    const matches = matchWatches(
      [aircraft({ longitude: -121.31 })],
      [geofenceWatch({ radiusM: 5000 })],
    );
    expect(matches).toHaveLength(0);
  });

  it("does not match an aircraft with missing position", () => {
    const matches = matchWatches(
      [aircraft({ latitude: null, longitude: null })],
      [geofenceWatch()],
    );
    expect(matches).toHaveLength(0);
  });

  it("respects maxAltitudeM, excluding an aircraft flying too high", () => {
    const matches = matchWatches(
      [aircraft({ geoAltitude: 5000, baroAltitude: 5000 })],
      [geofenceWatch({ maxAltitudeM: 2000 })],
    );
    expect(matches).toHaveLength(0);
  });

  it("falls back to baroAltitude when geoAltitude is missing, for the altitude gate", () => {
    const matches = matchWatches(
      [aircraft({ geoAltitude: null, baroAltitude: 1000 })],
      [geofenceWatch({ maxAltitudeM: 2000 })],
    );
    expect(matches).toHaveLength(1);
  });

  it("excludes an aircraft with no altitude data at all when maxAltitudeM is set", () => {
    const matches = matchWatches(
      [aircraft({ geoAltitude: null, baroAltitude: null })],
      [geofenceWatch({ maxAltitudeM: 2000 })],
    );
    expect(matches).toHaveLength(0);
  });

  it("skips a watch with incomplete geofence data (missing lat/lon/radius)", () => {
    const matches = matchWatches([aircraft()], [geofenceWatch({ radiusM: null })]);
    expect(matches).toHaveLength(0);
  });
});

describe("matchWatches — callsign watches", () => {
  it("matches by callsign, case-insensitively with whitespace trimmed", () => {
    const matches = matchWatches(
      [aircraft({ callsign: " test123 " })],
      [callsignWatch({ matchValue: "TEST123" })],
    );
    expect(matches).toHaveLength(1);
  });

  it("matches by icao24, case-insensitively", () => {
    const matches = matchWatches(
      [aircraft({ icao24: "abc123", callsign: null })],
      [callsignWatch({ matchValue: "ABC123" })],
    );
    expect(matches).toHaveLength(1);
  });

  it("does not match an unrelated callsign/icao24", () => {
    const matches = matchWatches(
      [aircraft({ callsign: "OTHER99", icao24: "zzz999" })],
      [callsignWatch({ matchValue: "TEST123" })],
    );
    expect(matches).toHaveLength(0);
  });

  it("skips a watch with no matchValue set", () => {
    const matches = matchWatches([aircraft()], [callsignWatch({ matchValue: null })]);
    expect(matches).toHaveLength(0);
  });
});

describe("matchWatches — cooldown", () => {
  it("suppresses a match still within the cooldown window", () => {
    const now = 1_000_000_000_000;
    const matches = matchWatches(
      [aircraft()],
      [geofenceWatch({ lastTriggeredAtMs: now - 10 * 60_000 })], // 10 min ago, cooldown is 30 min
      now,
    );
    expect(matches).toHaveLength(0);
  });

  it("allows a match again once the cooldown window has fully elapsed", () => {
    const now = 1_000_000_000_000;
    const matches = matchWatches(
      [aircraft()],
      [geofenceWatch({ lastTriggeredAtMs: now - 31 * 60_000 })], // 31 min ago, cooldown is 30 min
      now,
    );
    expect(matches).toHaveLength(1);
  });

  it("matches a watch that has never triggered before (lastTriggeredAtMs null)", () => {
    const matches = matchWatches([aircraft()], [geofenceWatch({ lastTriggeredAtMs: null })]);
    expect(matches).toHaveLength(1);
  });
});

describe("matchWatches — multiple watches/aircraft", () => {
  it("returns a match per watch, not per aircraft, when several watches hit", () => {
    const matches = matchWatches(
      [aircraft()],
      [geofenceWatch({ id: 1 }), callsignWatch({ id: 2 })],
    );
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.watch.id).sort()).toEqual([1, 2]);
  });

  it("matches the first qualifying aircraft when multiple are in range", () => {
    const matches = matchWatches(
      [aircraft({ icao24: "aaa111" }), aircraft({ icao24: "bbb222" })],
      [geofenceWatch()],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].aircraft.icao24).toBe("aaa111");
  });
});
