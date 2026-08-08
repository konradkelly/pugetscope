import { describe, expect, it } from "vitest";
import { parseRoute } from "./useUrlRoute.js";

describe("parseRoute", () => {
  it("parses an aircraft route, lowercasing the icao24", () => {
    expect(parseRoute("/aircraft/ABC123")).toEqual({ type: "aircraft", icao24: "abc123" });
  });

  it("parses a neighborhood route by 5-digit zip", () => {
    expect(parseRoute("/neighborhood/98108")).toEqual({ type: "neighborhood", zip: "98108" });
  });

  it("parses an airport route, uppercasing the icao", () => {
    expect(parseRoute("/airport/ksea")).toEqual({ type: "airport", icao: "KSEA" });
  });

  it("parses a dated digest route", () => {
    expect(parseRoute("/digest/2026-03-10")).toEqual({ type: "digest", date: "2026-03-10" });
  });

  it("parses a reset-password route, preserving token case", () => {
    expect(parseRoute("/reset-password/AbC-123_xyz")).toEqual({
      type: "resetPassword",
      token: "AbC-123_xyz",
    });
  });

  it("parses the bare /digest archive route", () => {
    expect(parseRoute("/digest")).toEqual({ type: "digestArchive" });
  });

  it("parses the bare /traffic overview route", () => {
    expect(parseRoute("/traffic")).toEqual({ type: "trafficOverview" });
  });

  it("falls back to home for the root path", () => {
    expect(parseRoute("/")).toEqual({ type: "home" });
  });

  it("falls back to home for an unrecognized path", () => {
    expect(parseRoute("/something/nonexistent")).toEqual({ type: "home" });
  });

  it("rejects a malformed icao24 (wrong length) and falls back to home", () => {
    expect(parseRoute("/aircraft/abc12")).toEqual({ type: "home" });
  });

  it("rejects a malformed zip (wrong length) and falls back to home", () => {
    expect(parseRoute("/neighborhood/9810")).toEqual({ type: "home" });
  });

  it("rejects a malformed digest date and falls back to home", () => {
    expect(parseRoute("/digest/2026-3-10")).toEqual({ type: "home" });
  });
});
