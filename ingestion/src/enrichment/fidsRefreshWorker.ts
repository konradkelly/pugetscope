import { config } from "../config.js";
import { fetchFidsBoard } from "./fidsClient.js";
import { getLastFetchedAt, replaceBoard } from "../db/fidsFlights.js";

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // just checks whether a refresh is due

async function maybeRefresh(): Promise<void> {
  const airportIcao = config.aerodatabox.airportIcao;
  try {
    // Whole function body wrapped, not just the fetch/write below: a
    // transient DB error here (e.g. a migration not yet applied) must never
    // crash the ingestion process — it did exactly this in practice, taking
    // down the whole service via an unhandled rejection, not just FIDS.
    const lastFetchedAt = await getLastFetchedAt(airportIcao);
    const dueAt = lastFetchedAt
      ? lastFetchedAt.getTime() + config.aerodatabox.refreshIntervalMs
      : 0;

    if (Date.now() < dueAt) return;

    const flights = await fetchFidsBoard(airportIcao);
    await replaceBoard(airportIcao, flights);
    console.log(`[fids] refreshed ${airportIcao} board: ${flights.length} flights`);
  } catch (err) {
    console.warn(`[fids] refresh failed for ${airportIcao}, will retry next check:`, (err as Error).message);
  }
}

/**
 * Starts the FIDS board refresh loop, gated on AERODATABOX_API_KEY being set
 * (opt-in tier-1 enrichment — docs/SPEC.md §12). Checks every 5 min whether a
 * refresh is due per the configured interval, rather than using a naive
 * setInterval(fetch, refreshIntervalMs) — that would re-fetch immediately on
 * every service restart and could burn through the monthly request budget
 * across frequent redeploys. The due-check reads a persisted last-fetch
 * timestamp instead, so restarts don't reset the cadence.
 */
export function startFidsRefreshWorker(): void {
  if (!config.aerodatabox.apiKey) {
    console.log("[fids] AERODATABOX_API_KEY not set — FIDS enrichment disabled");
    return;
  }
  console.log(
    `[fids] worker started for ${config.aerodatabox.airportIcao}, ` +
      `refreshing at most every ${config.aerodatabox.refreshIntervalMs / 60_000}min`,
  );
  void maybeRefresh(); // check immediately in case a refresh is overdue
  setInterval(() => void maybeRefresh(), CHECK_INTERVAL_MS);
}
