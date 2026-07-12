export const config = {
  apiUrl: import.meta.env.VITE_API_URL ?? "http://localhost:3000",
  wsUrl: import.meta.env.VITE_WS_URL ?? "ws://localhost:3001/live",
};

// Matches docs/SPEC.md §3
export const PUGET_SOUND_CENTER: [number, number] = [-122.55, 47.55];
export const PUGET_SOUND_DEFAULT_ZOOM = 9;
