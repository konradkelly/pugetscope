import { pool } from "../db/postgres.js";
import { lookupAdsbdb, lookupHexdb, type AircraftMetadata } from "./aircraftLookupClient.js";

// Self-imposed rate limit against two free, volunteer-run APIs (docs/SPEC.md
// §12's "be a good citizen" precedent for adsbdb) — this runs sequentially
// per icao24, so this is the delay between requests, not a batch size.
const DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getGapIcao24s(): Promise<string[]> {
  const result = await pool.query<{ icao24: string }>(
    `SELECT icao24 FROM aircraft
     WHERE registration IS NULL OR manufacturer IS NULL OR model IS NULL OR operator IS NULL`,
  );
  return result.rows.map((r) => r.icao24);
}

async function applyMetadata(icao24: string, meta: AircraftMetadata): Promise<void> {
  // COALESCE so a lower-confidence fallback hit never overwrites a real value
  // the bulk CSV pass already found.
  await pool.query(
    `UPDATE aircraft
     SET registration = COALESCE(registration, $2),
         manufacturer = COALESCE(manufacturer, $3),
         model = COALESCE(model, $4),
         typecode = COALESCE(typecode, $5),
         operator = COALESCE(operator, $6)
     WHERE icao24 = $1`,
    [icao24, meta.registration, meta.manufacturer, meta.model, meta.typecode, meta.operator],
  );
}

/**
 * Second-pass fallback for aircraft loadAircraftDatabase.ts's bulk CSV import
 * left partially or fully blank (either genuinely absent from OpenSky's
 * dataset, or present with some columns empty). Tries adsbdb, falling back to
 * hexdb, per icao24.
 */
export async function fillMissingAircraft(): Promise<void> {
  const gaps = await getGapIcao24s();
  console.log(`[enrichment] ${gaps.length} aircraft still missing fields, trying adsbdb/hexdb`);

  let filled = 0;
  let stillMissing = 0;

  for (const icao24 of gaps) {
    let meta: AircraftMetadata | null = null;
    try {
      meta = await lookupAdsbdb(icao24);
      if (!meta) meta = await lookupHexdb(icao24);
    } catch (err) {
      // Transient (network/5xx): skip for this run rather than treat as a
      // confirmed miss — a future re-run will pick it back up since it's
      // still NULL.
      console.warn(`[enrichment] fallback lookup failed for ${icao24}:`, (err as Error).message);
    }

    if (meta) {
      await applyMetadata(icao24, meta);
      filled++;
    } else {
      stillMissing++;
    }

    await sleep(DELAY_MS);
  }

  console.log(`[enrichment] fallback lookup: filled ${filled}, still missing ${stillMissing}`);
}
