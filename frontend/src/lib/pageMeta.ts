import { AIRPORT_OPTIONS } from "../components/AirportBoardPanel.js";
import { ZIP_OPTIONS } from "../components/NeighborhoodAnalyticsPanel.js";
import type { UrlRoute } from "./useUrlRoute.js";

const SITE_TITLE = "PugetScope";
const DEFAULT_TITLE = `${SITE_TITLE} — Live Puget Sound Aircraft Tracker`;
const DEFAULT_DESCRIPTION =
  "Track live flights over Sea-Tac, Boeing Field, and the rest of Puget Sound in real time — see per-flight details and how aircraft noise affects your neighborhood.";

export function getPageMeta(route: UrlRoute): { title: string; description: string } {
  switch (route.type) {
    case "airport": {
      const label = AIRPORT_OPTIONS.find((a) => a.icao === route.icao)?.label ?? route.icao;
      return {
        title: `${label} Live Departures & Arrivals | ${SITE_TITLE}`,
        description: `Live departure and arrival board for ${label}, part of ${SITE_TITLE}'s real-time Puget Sound aircraft tracker.`,
      };
    }
    case "neighborhood": {
      const label = ZIP_OPTIONS.find((z) => z.zip === route.zip)?.label ?? route.zip;
      return {
        title: `${label} Aircraft Noise Analytics | ${SITE_TITLE}`,
        description: `Overflight frequency and aircraft noise analytics for ${label}, tracked live by ${SITE_TITLE}.`,
      };
    }
    case "aircraft": {
      const icao24 = route.icao24.toUpperCase();
      return {
        title: `Aircraft ${icao24} — Live Tracking | ${SITE_TITLE}`,
        description: `Live position and flight details for aircraft ${icao24}, tracked by ${SITE_TITLE}.`,
      };
    }
    case "digest": {
      // Generic fallback — the real headline/description are already in the
      // server-rendered HTML crawlers see (api/src/routes/digest.ts); this
      // just covers the client-side title once the SPA has taken over.
      return {
        title: `Daily Digest — ${route.date} | ${SITE_TITLE}`,
        description: `${SITE_TITLE}'s AI-written summary of Puget Sound air traffic on ${route.date}.`,
      };
    }
    case "digestArchive":
      return {
        title: `Daily Digest Archive | ${SITE_TITLE}`,
        description: `Browse ${SITE_TITLE}'s archive of daily AI-written summaries of Puget Sound air traffic.`,
      };
    case "trafficOverview":
      return {
        title: `Puget Sound Air Traffic Overview | ${SITE_TITLE}`,
        description: `Region-wide flight volume across Sea-Tac, Paine Field, Boeing Field, Renton, and Tacoma Narrows, tracked live by ${SITE_TITLE}.`,
      };
    case "home":
    default:
      return { title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION };
  }
}
