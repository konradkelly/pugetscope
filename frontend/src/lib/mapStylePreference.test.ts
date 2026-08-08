import { beforeEach, describe, expect, it } from "vitest";
import { getStoredMapStylePref, setStoredMapStylePref } from "./mapStylePreference.js";
import { DEFAULT_BASE_STYLE_ID } from "./basemapStyles.js";

const STORAGE_KEY = "pugetscope_map_style";

beforeEach(() => {
  localStorage.clear();
});

describe("getStoredMapStylePref", () => {
  it("returns the default when nothing is stored", () => {
    expect(getStoredMapStylePref()).toEqual({ baseStyle: DEFAULT_BASE_STYLE_ID, terrain: false });
  });

  it("returns a validly stored preference as-is", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ baseStyle: "dark", terrain: true }));
    expect(getStoredMapStylePref()).toEqual({ baseStyle: "dark", terrain: true });
  });

  it("falls back to the default baseStyle when the stored one isn't a recognized id", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ baseStyle: "not-a-real-style", terrain: true }));
    expect(getStoredMapStylePref()).toEqual({ baseStyle: DEFAULT_BASE_STYLE_ID, terrain: true });
  });

  it("falls back to the default terrain flag when the stored one isn't a boolean", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ baseStyle: "dark", terrain: "yes" }));
    expect(getStoredMapStylePref()).toEqual({ baseStyle: "dark", terrain: false });
  });

  it("falls back to the full default when the stored value is corrupt JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{not valid json");
    expect(getStoredMapStylePref()).toEqual({ baseStyle: DEFAULT_BASE_STYLE_ID, terrain: false });
  });
});

describe("setStoredMapStylePref", () => {
  it("round-trips through localStorage", () => {
    setStoredMapStylePref({ baseStyle: "satellite", terrain: false });
    expect(getStoredMapStylePref()).toEqual({ baseStyle: "satellite", terrain: false });
  });
});
