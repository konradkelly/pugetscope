import { describe, expect, it } from "vitest";
import { getPageMeta } from "./pageMeta.js";
import type { UrlRoute } from "./useUrlRoute.js";

describe("getPageMeta", () => {
  it("home", () => {
    const meta = getPageMeta({ type: "home" });
    expect(meta.title).toContain("PugetScope");
    expect(meta.description.length).toBeGreaterThan(0);
  });

  it("airport — uses the known label for a real ICAO", () => {
    const meta = getPageMeta({ type: "airport", icao: "KSEA" });
    expect(meta.title).toContain("KSEA — Sea-Tac Intl");
  });

  it("airport — falls back to the bare icao for an unrecognized one", () => {
    const meta = getPageMeta({ type: "airport", icao: "ZZZZ" });
    expect(meta.title).toContain("ZZZZ");
  });

  it("neighborhood — uses the known label for a real zip", () => {
    const meta = getPageMeta({ type: "neighborhood", zip: "98108" });
    expect(meta.title).toContain("98108 — Beacon Hill / Georgetown");
  });

  it("neighborhood — falls back to the bare zip for an unrecognized one", () => {
    const meta = getPageMeta({ type: "neighborhood", zip: "00000" });
    expect(meta.title).toContain("00000");
  });

  it("aircraft — uppercases the icao24 in the title", () => {
    const meta = getPageMeta({ type: "aircraft", icao24: "abc123" });
    expect(meta.title).toContain("ABC123");
  });

  it("digest — includes the date", () => {
    const meta = getPageMeta({ type: "digest", date: "2026-03-10" });
    expect(meta.title).toContain("2026-03-10");
  });

  it("digestArchive / trafficOverview / resetPassword — return distinct, non-empty titles", () => {
    const routes: UrlRoute[] = [
      { type: "digestArchive" },
      { type: "trafficOverview" },
      { type: "resetPassword", token: "abc" },
    ];
    const titles = routes.map((r) => getPageMeta(r).title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const title of titles) expect(title.length).toBeGreaterThan(0);
  });

  it("resetPassword — never includes the token in title or description", () => {
    const meta = getPageMeta({ type: "resetPassword", token: "super-secret-token" });
    expect(meta.title).not.toContain("super-secret-token");
    expect(meta.description).not.toContain("super-secret-token");
  });
});
