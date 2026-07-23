import { pool } from "../db/postgres.js";
import type { StateVector } from "../openskyClient.js";

export type WithAircraftType<T> = T & { typecode: string | null };

/**
 * Attaches the ICAO type designator (e.g. "B738", "C172") from the `aircraft`
 * reference table (populated by `npm run enrich`, see loadAircraftDatabase.ts)
 * to each state. Live ADS-B `category` is present for only a small fraction
 * of Puget Sound traffic in practice (most GA and plenty of airliners don't
 * broadcast it) — typecode is the primary signal for the "big commercial vs
 * small private" marker classification, with category as a fallback for
 * aircraft with no reference-data match. See
 * docs/Aircraft-type-visual-differentiation.md.
 */
export async function attachAircraftType<T extends StateVector>(
  states: T[],
): Promise<WithAircraftType<T>[]> {
  if (states.length === 0) return [];

  const icao24s = [...new Set(states.map((s) => s.icao24))];
  const { rows } = await pool.query<{ icao24: string; typecode: string | null }>(
    `SELECT icao24, typecode FROM aircraft WHERE icao24 = ANY($1::text[])`,
    [icao24s],
  );
  const typecodeByIcao24 = new Map(rows.map((r) => [r.icao24, r.typecode]));

  return states.map((s) => ({ ...s, typecode: typecodeByIcao24.get(s.icao24) ?? null }));
}
