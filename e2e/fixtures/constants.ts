// Split from seed.ts so specs can import known seeded values without also
// importing (and re-running) seed.ts's own main()/process.exit() side
// effects — the same "extract the side-effect-free part" fix as Phase 0's
// buildApp() extraction in api/websocket.
export const SEEDED_AIRCRAFT_ICAO24 = "e2e0001";
export const SEEDED_AIRCRAFT_CALLSIGN = "E2E001";
export const SEEDED_AIRCRAFT_REGISTRATION = "N999E2E";
export const SEEDED_AIRCRAFT_MODEL = "737-800";
export const SEEDED_LOGIN_EMAIL = "e2e-login@pugetscope.test";
export const SEEDED_LOGIN_PASSWORD = "e2e-password-123";

// Mirrors frontend/src/lib/config.ts's PUGET_SOUND_CENTER — duplicated
// rather than imported (this repo's usual per-service convention, see
// websocket/src/alerts/matching.ts's haversine comment) since that file
// reads import.meta.env, which only exists under Vite's own bundler and
// would throw if imported directly under plain tsx/Node here.
export const PUGET_SOUND_CENTER: [number, number] = [-122.34, 47.53];
