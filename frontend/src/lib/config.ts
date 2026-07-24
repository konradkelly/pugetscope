export const config = {
  apiUrl: import.meta.env.VITE_API_URL ?? "http://localhost:3000",
  wsUrl: import.meta.env.VITE_WS_URL ?? "ws://localhost:3001/live",
};

// Matches docs/SPEC.md §3 (same box ingestion/src/config.ts polls OpenSky
// against, so the map can't be panned/zoomed to where there's no data anyway),
// padded out by ~0.4° on each side so the clamp gives some breathing room —
// surrounding geography for context — rather than cutting off right at the
// data boundary.
export const PUGET_SOUND_CENTER: [number, number] = [-122.55, 47.55];
export const PUGET_SOUND_DEFAULT_ZOOM = 9;
export const PUGET_SOUND_MAX_BOUNDS: [[number, number], [number, number]] = [
  [-123.6, 46.6],
  [-121.5, 48.8],
];
export const PUGET_SOUND_MIN_ZOOM = 7;
