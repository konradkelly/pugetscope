import { config } from "../config.js";
import { fetchFidsBoard } from "./fidsClient.js";
import { getLastFetchedAt, replaceBoard } from "../db/fidsFlights.js";
import { REGIONAL_AIRPORTS } from "./regionalAirports.js";

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // just checks whether a refresh is due

// KSEA gets the tighter cadence (much higher traffic); the other 4 regional
// fields share a slower one — see the budget math in config.ts.
const PRIMARY_ICAO = "KSEA";

function refreshIntervalFor(airportIcao: string): number {
  return airportIcao === PRIMARY_ICAO
    ? config.aerodatabox.primaryRefreshIntervalMs
    : config.aerodatabox.secondaryRefreshIntervalMs;
}

async function maybeRefresh(airportIcao: string): Promise<void> {
  try {
    // Whole function body wrapped, not just the fetch/write below: a
    // transient DB error here (e.g. a migration not yet applied) must never
    // crash the ingestion process — it did exactly this in practice, taking
    // down the whole service via an unhandled rejection, not just FIDS.
    const lastFetchedAt = await getLastFetchedAt(airportIcao);
    const dueAt = lastFetchedAt
      ? lastFetchedAt.getTime() + refreshIntervalFor(airportIcao)
      : 0;

    if (Date.now() < dueAt) return;

    const flights = await fetchFidsBoard(airportIcao);
    await replaceBoard(airportIcao, flights);
    console.log(`[fids] refreshed ${airportIcao} board: ${flights.length} flights`);
  } catch (err) {
    console.warn(`[fids] refresh failed for ${airportIcao}, will retry next check:`, (err as Error).message);
  }
}

const STAGGER_MS = 1500; // RapidAPI enforces a per-second rate limit, separate from the monthly unit budget

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sequential with a stagger, not Promise.all: firing all 5 airport requests
// at once tripped RapidAPI's per-second rate limit (429), even though the
// monthly unit budget has headroom (docs/SPEC.md §12).
async function maybeRefreshAll(): Promise<void> {
  for (const airport of REGIONAL_AIRPORTS) {
    await maybeRefresh(airport.icao);
    await sleep(STAGGER_MS);
  }
}

/**
 * Starts the FIDS board refresh loop, gated on AERODATABOX_API_KEY being set
 * (opt-in tier-1 enrichment — docs/SPEC.md §12). Checks every 5 min whether a
 * refresh is due per airport, rather than using a naive
 * setInterval(fetch, refreshIntervalMs) — that would re-fetch immediately on
 * every service restart and could burn through the monthly request budget
 * across frequent redeploys. Each airport's due-check reads its own persisted
 * last-fetch timestamp instead, so restarts don't reset its cadence.
 */
export function startFidsRefreshWorker(): void {
  if (!config.aerodatabox.apiKey) {
    console.log("[fids] AERODATABOX_API_KEY not set — FIDS enrichment disabled");
    return;
  }
  console.log(
    `[fids] worker started for ${REGIONAL_AIRPORTS.map((a) => a.icao).join(", ")}, ` +
      `refreshing ${PRIMARY_ICAO} at most every ${config.aerodatabox.primaryRefreshIntervalMs / 60_000}min ` +
      `and the rest at most every ${config.aerodatabox.secondaryRefreshIntervalMs / 60_000}min`,
  );
  void maybeRefreshAll(); // check immediately in case a refresh is overdue
  setInterval(() => void maybeRefreshAll(), CHECK_INTERVAL_MS);
}
