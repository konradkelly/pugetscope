// Classifies the OpenSky ADS-B emitter `category` field (see StateVector in
// useAircraftFeed.ts) into a small set of buckets that drive marker
// size/shape on the map — see docs/Aircraft-type-visual-differentiation.md.
//
// Category value table (DO-260B emitter category, as returned by OpenSky):
//   0-1 no info, 2 small, 3-4 large, 5-6 heavy, 8 rotorcraft, 9 glider,
//   10-12 ultralight/LTA, 14 UAV, 16-20 surface vehicle/obstacle.
// Values with no bucket below (7, 13, 15-20, and anything unrecognized)
// fall through to "unknown" — including surface vehicles/obstacles for now
// (see plan doc's open questions on filtering those at ingestion instead).
export type AircraftClass =
  | "heavy"
  | "large"
  | "small"
  | "rotorcraft"
  | "glider"
  | "ultralight"
  | "uav"
  | "unknown";

const CATEGORY_TO_CLASS: Record<number, AircraftClass> = {
  2: "small",
  3: "large",
  4: "large",
  5: "heavy",
  6: "heavy",
  8: "rotorcraft",
  9: "glider",
  10: "ultralight",
  11: "ultralight",
  12: "ultralight",
  14: "uav",
};

export function classifyCategory(category: number | null | undefined): AircraftClass {
  if (category == null) return "unknown";
  return CATEGORY_TO_CLASS[category] ?? "unknown";
}

// Live ADS-B `category` is only present for a small fraction of Puget Sound
// traffic in practice (most GA, and plenty of airliners, don't broadcast
// it — see docs/Aircraft-type-visual-differentiation.md). The ICAO type
// designator from the `aircraft` reference table (populated by
// `npm run enrich`) is a far more reliable "big commercial vs. small
// private" signal, since it doesn't depend on what the aircraft happens to
// broadcast — so it's checked first, with category as the fallback.
//
// This table is deliberately NOT an exhaustive DOC 8643 type-designator
// list — it's built from typecodes actually observed in this project's
// Puget Sound feed, plus a light prefix fallback for common manufacturer
// families not yet seen. Extend EXACT_TYPECODE_CLASS as new types turn up.
const EXACT_TYPECODE_CLASS: Record<string, AircraftClass> = {
  // Heavy / wide-body
  B744: "heavy", B763: "heavy", B77W: "heavy", B779: "heavy",
  B789: "heavy", B78X: "heavy", A332: "heavy", A359: "heavy",
  // Large / mainline + regional airliner
  B733: "large", B737: "large", B738: "large", B739: "large",
  B38M: "large", B39M: "large", B752: "large", B753: "large",
  A319: "large", A320: "large", A321: "large", A20N: "large", A21N: "large",
  BCS3: "large", E75L: "large", E545: "large", CRJ7: "large", DH8D: "large",
  // Small / GA + business jet + private turboprop
  C150: "small", C152: "small", C172: "small", C180: "small", C182: "small",
  C185: "small", C206: "small", C208: "small", C210: "small", T206: "small",
  T210: "small", C72R: "small", C82R: "small", C82S: "small", C82T: "small",
  DHC2: "small", DHC3: "small", P28A: "small", P28B: "small", PA18: "small",
  PA22: "small", PA23: "small", PA24: "small", PA30: "small", PA31: "small",
  BE35: "small", T34P: "small", M20P: "small", SR22: "small", S22T: "small",
  DA40: "small", DA42: "small", RV6: "small", RV8: "small", RV12: "small",
  BL8: "small", CH7B: "small", MOR2: "small", LA25: "small", VR7: "small",
  NAVI: "small", PC12: "small", GLF4: "small", GALX: "small", CL35: "small",
  C56X: "small", C560: "small", C680: "small", C700: "small", C68A: "small",
  C25B: "small", SF50: "small",
  // Rotorcraft
  H60: "rotorcraft", EC35: "rotorcraft", B06: "rotorcraft", B407: "rotorcraft",
  R44: "rotorcraft", AS65: "rotorcraft", H500: "rotorcraft",
};

// Checked only when there's no exact match above — ordered longest/most
// specific prefix first so a broad fallback doesn't shadow a narrower one.
const TYPECODE_PREFIX_CLASS: [string, AircraftClass][] = [
  ["C17", "heavy"], // military heavy-lift cargo, not to be confused with C172 (exact-matched above)
  ["B74", "heavy"], ["B76", "heavy"], ["B77", "heavy"], ["B78", "heavy"],
  ["A33", "heavy"], ["A34", "heavy"], ["A35", "heavy"], ["A38", "heavy"],
  ["B73", "large"], ["B75", "large"], ["A31", "large"], ["A32", "large"],
  ["A19", "large"], ["A20", "large"], ["A21", "large"], ["BCS", "large"],
  ["E17", "large"], ["E19", "large"], ["E7", "large"], ["E9", "large"],
  ["CRJ", "large"], ["DH8", "large"], ["AT4", "large"], ["AT7", "large"],
  ["SF3", "large"],
  ["GLF", "small"], ["G150", "small"], ["G200", "small"], ["G280", "small"],
  ["CL3", "small"], ["CL6", "small"], ["LJ", "small"], ["PC24", "small"],
  ["DHC", "small"], ["C1", "small"], ["C2", "small"], ["T20", "small"],
  ["P28", "small"], ["PA", "small"], ["BE", "small"], ["M20", "small"],
  ["SR2", "small"], ["DA4", "small"], ["RV", "small"],
  ["EC1", "rotorcraft"], ["EC2", "rotorcraft"], ["EC3", "rotorcraft"],
  ["AS3", "rotorcraft"], ["AS5", "rotorcraft"], ["AS6", "rotorcraft"],
  ["B40", "rotorcraft"], ["B41", "rotorcraft"], ["R2", "rotorcraft"],
  ["R4", "rotorcraft"], ["R6", "rotorcraft"], ["MD5", "rotorcraft"],
  ["MD6", "rotorcraft"], ["S76", "rotorcraft"], ["S92", "rotorcraft"],
];

export function classifyTypecode(typecode: string | null | undefined): AircraftClass | null {
  if (!typecode) return null;
  const code = typecode.trim().toUpperCase();
  if (!code) return null;
  if (EXACT_TYPECODE_CLASS[code]) return EXACT_TYPECODE_CLASS[code];
  for (const [prefix, cls] of TYPECODE_PREFIX_CLASS) {
    if (code.startsWith(prefix)) return cls;
  }
  return null;
}

/** Primary classifier: typecode first (reliable but reference-data-dependent
 * — needs `npm run enrich` to have run against the tracked icao24, see
 * ingestion/src/enrichment/loadAircraftDatabase.ts), falling back to live
 * ADS-B category for anything not yet enriched. */
export function classifyAircraft(state: {
  typecode?: string | null;
  category?: number | null;
}): AircraftClass {
  return classifyTypecode(state.typecode) ?? classifyCategory(state.category);
}

// Order used by both the map (z-consistency isn't relevant there) and the
// legend, largest/most-common classes first.
export const AIRCRAFT_CLASSES: AircraftClass[] = [
  "heavy",
  "large",
  "small",
  "rotorcraft",
  "glider",
  "ultralight",
  "uav",
  "unknown",
];

export const AIRCRAFT_CLASS_LABEL: Record<AircraftClass, string> = {
  heavy: "Heavy / wide-body",
  large: "Large / airliner",
  small: "Small / GA",
  rotorcraft: "Rotorcraft",
  glider: "Glider",
  ultralight: "Ultralight / lighter-than-air",
  uav: "UAV / drone",
  unknown: "Unknown",
};

// Rendered marker width/height in px. "unknown" matches the pre-existing
// single-glyph size so unclassified aircraft (most GA, and any airliner
// without a category broadcast) don't look worse than they did before this
// feature shipped.
export const AIRCRAFT_CLASS_SIZE: Record<AircraftClass, number> = {
  heavy: 28,
  large: 20,
  small: 15,
  rotorcraft: 18,
  glider: 20,
  ultralight: 13,
  uav: 13,
  unknown: 20,
};

// Inner SVG markup (viewBox "0 0 24 24", nose pointing up/north — matches
// the rotation convention in AircraftMap's marker.setRotation(trueTrack))
// per class. Original silhouettes inspired by common ADS-B viewer
// conventions (tar1090 et al.), not copied from any GPL-licensed source —
// see docs/Aircraft-type-visual-differentiation.md open questions.
export const AIRCRAFT_CLASS_ICON: Record<AircraftClass, string> = {
  // Same silhouette as "large" but broader wingspan/blunter nose+tail.
  heavy: `<path d="M12 1.5 L15.5 13.5 L23.5 16 L23.5 18.5 L15 16.5 L14 22 L18 23 L18 24.5 L12 23 L6 24.5 L6 23 L10 22 L9 16.5 L0.5 18.5 L0.5 16 L8.5 13.5 Z" />`,
  // The original placeholder glyph — kept as the "standard" silhouette.
  large: `<path d="M12 2 L15 14 L22 17 L22 19 L15 17.5 L14 22 L17 23 L17 24 L12 22.5 L7 24 L7 23 L10 22 L9 17.5 L2 19 L2 17 L9 14 Z" />`,
  // Shorter wings, thinner fuselage — single-engine GA proportions.
  small: `<path d="M12 4 L13.5 13 L19 15 L19 16.5 L13.5 15 L13 20 L15 20.5 L15 21.5 L12 21 L9 21.5 L9 20.5 L11 20 L10.5 15 L5 16.5 L5 15 L10.5 13 Z" />`,
  // Long straight wings relative to a short fuselage, T-tail — no engine bulk.
  glider: `<path d="M12 5 L12.8 12 L23 14 L23 15 L12.8 13.5 L12.5 20 L15 21 L15 22 L12 21.3 L9 22 L9 21 L11.5 20 L11.2 13.5 L1 15 L1 14 L11.2 12 Z" />`,
  // Rotor disc + fuselage/tail-boom + tail rotor.
  rotorcraft: `<circle cx="12" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.2" /><path d="M12 6 L14.2 11 L14.2 18 L9.8 18 L9.8 11 Z" /><circle cx="12" cy="20.2" r="1.6" fill="none" stroke="currentColor" stroke-width="1.2" />`,
  // Minimal delta/kite shape (ultralight, hang-glider, lighter-than-air).
  ultralight: `<path d="M12 5 L18.5 18 L12 15 L5.5 18 Z" />`,
  // Quadcopter top view: four rotors + center body.
  uav: `<circle cx="6.5" cy="6.5" r="2.3" fill="none" stroke="currentColor" stroke-width="1.2" /><circle cx="17.5" cy="6.5" r="2.3" fill="none" stroke="currentColor" stroke-width="1.2" /><circle cx="6.5" cy="17.5" r="2.3" fill="none" stroke="currentColor" stroke-width="1.2" /><circle cx="17.5" cy="17.5" r="2.3" fill="none" stroke="currentColor" stroke-width="1.2" /><line x1="6.5" y1="6.5" x2="17.5" y2="17.5" stroke="currentColor" stroke-width="1.2" /><line x1="17.5" y1="6.5" x2="6.5" y2="17.5" stroke="currentColor" stroke-width="1.2" /><rect x="9.8" y="9.8" width="4.4" height="4.4" />`,
  unknown: `<path d="M12 2 L15 14 L22 17 L22 19 L15 17.5 L14 22 L17 23 L17 24 L12 22.5 L7 24 L7 23 L10 22 L9 17.5 L2 19 L2 17 L9 14 Z" />`,
};
