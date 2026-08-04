import { BASE_STYLES, DEFAULT_BASE_STYLE_ID, type BaseStyleId } from "./basemapStyles.js";

const STORAGE_KEY = "pugetscope_map_style";

export interface StoredMapStylePref {
  baseStyle: BaseStyleId;
  terrain: boolean;
}

const DEFAULT_PREF: StoredMapStylePref = { baseStyle: DEFAULT_BASE_STYLE_ID, terrain: false };

function isValidBaseStyleId(value: unknown): value is BaseStyleId {
  return typeof value === "string" && BASE_STYLES.some((s) => s.id === value);
}

// Anonymous-first, unlike the account-only mapView preference (api.ts) —
// basemap choice works with no login required, same "anonymous by default,
// account adds sync" posture the alerts feature established (see
// docs/SPEC.md §18). Read synchronously before the map is constructed so
// there's no flash-of-default-then-switch for a returning visitor.
export function getStoredMapStylePref(): StoredMapStylePref {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_PREF;

  try {
    const parsed = JSON.parse(raw) as Partial<StoredMapStylePref>;
    return {
      baseStyle: isValidBaseStyleId(parsed.baseStyle) ? parsed.baseStyle : DEFAULT_PREF.baseStyle,
      terrain: typeof parsed.terrain === "boolean" ? parsed.terrain : DEFAULT_PREF.terrain,
    };
  } catch {
    // A corrupt/legacy value shouldn't break the map — just fall back.
    return DEFAULT_PREF;
  }
}

export function setStoredMapStylePref(pref: StoredMapStylePref): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(pref));
}
