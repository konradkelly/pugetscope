import { describe, expect, it } from "vitest";
import { classifyCategory, classifyTypecode, classifyAircraft } from "./aircraftCategory.js";

describe("classifyCategory", () => {
  it("classifies known DO-260B emitter categories", () => {
    expect(classifyCategory(2)).toBe("small");
    expect(classifyCategory(5)).toBe("heavy");
    expect(classifyCategory(8)).toBe("rotorcraft");
    expect(classifyCategory(9)).toBe("glider");
    expect(classifyCategory(14)).toBe("uav");
  });

  it("falls back to 'unknown' for null/undefined", () => {
    expect(classifyCategory(null)).toBe("unknown");
    expect(classifyCategory(undefined)).toBe("unknown");
  });

  it("falls back to 'unknown' for an unmapped category (e.g. surface vehicle)", () => {
    expect(classifyCategory(17)).toBe("unknown");
  });
});

describe("classifyTypecode", () => {
  it("resolves an exact typecode match, case-insensitively", () => {
    expect(classifyTypecode("b738")).toBe("large");
    expect(classifyTypecode("B744")).toBe("heavy");
  });

  it("trims whitespace before matching", () => {
    expect(classifyTypecode("  C172 ")).toBe("small");
  });

  it("falls back to a prefix match when there's no exact entry", () => {
    // C172 is exact-matched to "small"; a made-up C1-prefixed code with no
    // exact entry should still resolve via the ["C1", "small"] prefix rule.
    expect(classifyTypecode("C199")).toBe("small");
  });

  it("prefers the more specific military C17 prefix over the general C1 prefix", () => {
    expect(classifyTypecode("C17X")).toBe("heavy");
  });

  it("returns null for an unrecognized typecode", () => {
    expect(classifyTypecode("ZZZZ")).toBeNull();
  });

  it("returns null for null/undefined/empty input", () => {
    expect(classifyTypecode(null)).toBeNull();
    expect(classifyTypecode(undefined)).toBeNull();
    expect(classifyTypecode("   ")).toBeNull();
  });
});

describe("classifyAircraft", () => {
  it("prefers typecode over category when both are present", () => {
    expect(classifyAircraft({ typecode: "B744", category: 2 })).toBe("heavy");
  });

  it("falls back to category when typecode doesn't resolve", () => {
    expect(classifyAircraft({ typecode: "ZZZZ", category: 8 })).toBe("rotorcraft");
  });

  it("falls back to category when typecode is absent", () => {
    expect(classifyAircraft({ category: 9 })).toBe("glider");
  });

  it("is 'unknown' when neither typecode nor category resolve", () => {
    expect(classifyAircraft({})).toBe("unknown");
  });
});
