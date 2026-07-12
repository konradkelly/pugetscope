import { Readable } from "node:stream";
import { parse } from "csv-parse";
import { pool } from "../db/postgres.js";

// Official OpenSky aircraft metadata CSV — see docs/SPEC.md §7. Redirects to
// an S3-hosted file; the database as a whole aggregates FAA + other national
// registries and updates irregularly (periodic snapshots, not a live API).
const AIRCRAFT_DATABASE_URL =
  "https://opensky-network.org/datasets/metadata/aircraftDatabase.csv";

interface AircraftDatabaseRow {
  icao24: string;
  registration: string;
  manufacturericao: string;
  manufacturername: string;
  model: string;
  typecode: string;
  operator: string;
}

async function getTrackedIcao24s(): Promise<Set<string>> {
  const result = await pool.query<{ icao24: string }>("SELECT icao24 FROM aircraft");
  return new Set(result.rows.map((r) => r.icao24));
}

/**
 * Enriches reference data (registration/manufacturer/model/typecode/operator)
 * for aircraft the ingestion service has actually seen in the Puget Sound
 * bbox. Deliberately scoped to already-tracked icao24s rather than importing
 * the OpenSky database's full global aircraft list (hundreds of thousands of
 * rows for airframes we'll never see) — see docs/SPEC.md §1 depth-over-breadth.
 * Streams the CSV once rather than buffering it (the file is tens of MB+).
 */
export async function runEnrichment(): Promise<void> {
  const tracked = await getTrackedIcao24s();
  console.log(`[enrichment] ${tracked.size} tracked aircraft to look up`);

  if (tracked.size === 0) {
    console.log("[enrichment] nothing tracked yet — run the ingestion poller first");
    return;
  }

  const res = await fetch(AIRCRAFT_DATABASE_URL);
  if (!res.ok || !res.body) {
    throw new Error(`failed to download aircraft database: ${res.status}`);
  }

  const parser = parse({ columns: true, relax_quotes: true, skip_empty_lines: true });
  const rows = Readable.fromWeb(res.body as never).pipe(parser);

  let scanned = 0;
  let matched = 0;

  for await (const record of rows) {
    scanned++;
    const row = record as AircraftDatabaseRow;
    const icao24 = row.icao24?.toLowerCase().trim();
    if (!icao24 || !tracked.has(icao24)) continue;

    matched++;
    await pool.query(
      `UPDATE aircraft
       SET registration = $2, manufacturer = $3, model = $4, typecode = $5, operator = $6
       WHERE icao24 = $1`,
      [
        icao24,
        row.registration?.trim() || null,
        row.manufacturername?.trim() || row.manufacturericao?.trim() || null,
        row.model?.trim() || null,
        row.typecode?.trim() || null,
        row.operator?.trim() || null,
      ],
    );
  }

  console.log(
    `[enrichment] scanned ${scanned} rows, matched ${matched}/${tracked.size} tracked aircraft`,
  );
}
