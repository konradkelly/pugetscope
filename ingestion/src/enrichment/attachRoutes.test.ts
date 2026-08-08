import { describe, expect, it, vi, beforeEach } from "vitest";
import type { StateVector } from "../openskyClient.js";
import type { FidsMatch } from "../db/fidsFlights.js";

// Isolates attachRoutes.ts from Postgres entirely — findFidsMatches is the
// only external dependency (see fidsFlights.ts, which itself imports the
// real pg pool), so mocking this one module keeps the whole test in-memory.
// vi.hoisted is required here (not a plain top-level const) because vi.mock
// itself is hoisted above all other code in the file, including a normal
// variable declaration this factory would otherwise reference too early.
const { findFidsMatches } = vi.hoisted(() => ({
  findFidsMatches: vi.fn<(callsigns: string[]) => Promise<Map<string, FidsMatch>>>(),
}));
vi.mock("../db/fidsFlights.js", () => ({
  findFidsMatches: (callsigns: string[]) => findFidsMatches(callsigns),
}));

const { attachRoutes } = await import("./attachRoutes.js");

function baseState(overrides: Partial<StateVector> = {}): StateVector {
  return {
    icao24: "abc123",
    callsign: "TEST123",
    originCountry: "United States",
    timePosition: null,
    lastContact: 0,
    longitude: -122.31,
    latitude: 47.45,
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

beforeEach(() => {
  findFidsMatches.mockReset();
  findFidsMatches.mockResolvedValue(new Map());
});

describe("attachRoutes — own-track inference fallback (tier 2, no FIDS match)", () => {
  it("attaches an inferred 'landing' route (destination only) near KSEA when descending", () => {
    return attachRoutes([
      baseState({ geoAltitude: 300, verticalRate: -5 }),
    ]).then(([result]) => {
      expect(result.route).toMatchObject({
        confidence: "inferred",
        destination: { icao: "KSEA" },
        origin: null,
      });
    });
  });

  it("attaches an inferred 'departing' route (origin only) near KSEA when climbing", async () => {
    const [result] = await attachRoutes([
      baseState({ geoAltitude: 300, verticalRate: 5 }),
    ]);
    expect(result.route).toMatchObject({
      confidence: "inferred",
      origin: { icao: "KSEA" },
      destination: null,
    });
  });

  it("attaches no route at all when not near any regional airport", async () => {
    const [result] = await attachRoutes([
      baseState({ latitude: 40, longitude: -140, geoAltitude: 300, verticalRate: -5 }),
    ]);
    expect(result.route).toBeUndefined();
  });

  it("calls findFidsMatches with an empty list for a callsign-less state, and still applies own-track inference", async () => {
    const [result] = await attachRoutes([
      baseState({ callsign: null, geoAltitude: 300, verticalRate: -5 }),
    ]);
    expect(findFidsMatches).toHaveBeenCalledWith([]);
    expect(result.route?.confidence).toBe("inferred");
  });
});

describe("attachRoutes — FIDS match takes priority over own-track inference (tier 1)", () => {
  it("uses the live FIDS route even when own-track inference would also apply", async () => {
    findFidsMatches.mockResolvedValue(
      new Map([
        [
          "TEST123",
          {
            direction: "arrival",
            status: "Scheduled",
            airlineName: "Test Air",
            homeIcao: "KSEA",
            other: { icao: "KLAX", iata: "LAX", name: "Los Angeles Intl", lat: 33.94, lon: -118.4 },
            scheduledTime: null,
            revisedTime: new Date(Date.now() + 30 * 60_000), // 30 min from now — not stale
          } satisfies FidsMatch,
        ],
      ]),
    );

    const [result] = await attachRoutes([
      baseState({ geoAltitude: 300, verticalRate: -5, onGround: false }),
    ]);

    expect(result.route).toMatchObject({
      confidence: "live",
      airline: "Test Air",
      destination: { icao: "KSEA" },
      origin: { icao: "KLAX" },
    });
    expect(result.route?.eta).toBeDefined();
  });

  it("drops the ETA once the aircraft is on the ground, even with a future revisedTime", async () => {
    findFidsMatches.mockResolvedValue(
      new Map([
        [
          "TEST123",
          {
            direction: "arrival",
            status: "Scheduled",
            airlineName: "Test Air",
            homeIcao: "KSEA",
            other: { icao: "KLAX", iata: "LAX", name: "Los Angeles Intl", lat: 33.94, lon: -118.4 },
            scheduledTime: null,
            revisedTime: new Date(Date.now() + 30 * 60_000),
          } satisfies FidsMatch,
        ],
      ]),
    );

    const [result] = await attachRoutes([baseState({ onGround: true })]);

    expect(result.route?.confidence).toBe("live");
    expect(result.route?.eta).toBeUndefined();
  });

  it("batches all distinct callsigns from the poll into a single findFidsMatches call", async () => {
    await attachRoutes([
      baseState({ icao24: "a1", callsign: "AAA111" }),
      baseState({ icao24: "a2", callsign: "BBB222" }),
      baseState({ icao24: "a3", callsign: "AAA111" }), // duplicate callsign, should be de-duped
      baseState({ icao24: "a4", callsign: null }),
    ]);

    expect(findFidsMatches).toHaveBeenCalledTimes(1);
    const [calledWith] = findFidsMatches.mock.calls[0];
    expect(new Set(calledWith)).toEqual(new Set(["AAA111", "BBB222"]));
  });
});
