export const config = {
  apiUrl: import.meta.env.VITE_API_URL ?? "http://localhost:3000",
  wsUrl: import.meta.env.VITE_WS_URL ?? "ws://localhost:3001/live",
  // Empty disables push alerts client-side (see lib/push.ts) rather than
  // throwing — matches websocket/src/config.ts's server-side treatment of
  // an unset VAPID key pair.
  vapidPublicKey: import.meta.env.VITE_VAPID_PUBLIC_KEY ?? "",
};

// Centered on the actual airport corridor (average of REGIONAL_AIRPORTS in
// ingestion/src/enrichment/regionalAirports.ts: KSEA/KBFI/KRNT/KPAE/KTIW),
// not the ingestion bbox's geometric midpoint (docs/SPEC.md §3) — that bbox
// extends further west into the Olympics/Kitsap than east into the Cascades,
// so its midpoint sits well west of where the traffic and airports actually
// are, showing a lot of empty peninsula by default.
export const PUGET_SOUND_CENTER: [number, number] = [-122.34, 47.53];
export const PUGET_SOUND_DEFAULT_ZOOM = 9.3;
// Bbox padded out by ~0.2° on each side so the pan/zoom clamp gives a little
// breathing room — surrounding geography for context — without going as far
// as it did initially, which let you zoom/pan out to a lot of Olympic
// Mountains/Cascades with nothing on them.
export const PUGET_SOUND_MAX_BOUNDS: [[number, number], [number, number]] = [
  [-123.4, 46.8],
  [-121.7, 48.6],
];
export const PUGET_SOUND_MIN_ZOOM = 7.3;
