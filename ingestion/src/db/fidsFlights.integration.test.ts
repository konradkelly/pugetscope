import { describe, expect, it } from "vitest";
import { replaceBoard } from "./fidsFlights.js";
import { pool } from "./postgres.js";
import type { FidsFlight } from "../enrichment/fidsClient.js";

// 2026-08-14T18:00:00Z is 11:00 LA (PDT, UTC-7) — comfortably inside the
// 2026-08-14 LA calendar day, so the rollup's date bucketing is unambiguous.
const SCHEDULED = "2026-08-14T18:00:00.000Z";

function flight(overrides: Partial<FidsFlight> = {}): FidsFlight {
  return {
    direction: "arrival",
    callSign: "ASA1234",
    flightNumber: "AS1234",
    status: "Expected",
    airlineName: "Alaska Airlines",
    other: { icao: "KSFO", iata: "SFO", name: "San Francisco Intl", lat: 37.6, lon: -122.4 },
    scheduledTime: SCHEDULED,
    revisedTime: SCHEDULED,
    ...overrides,
  };
}

interface RollupRow {
  date: Date;
  airport_icao: string;
  direction: string;
  call_sign: string;
  flight_number: string | null;
  airline_name: string | null;
  status: string | null;
  other_name: string | null;
  scheduled_time: Date;
  revised_time: Date | null;
}

async function rollupRow(callSign: string): Promise<RollupRow | undefined> {
  const { rows } = await pool.query<RollupRow>(
    `SELECT date, airport_icao, direction, call_sign, flight_number, airline_name,
            status, other_name, scheduled_time, revised_time
     FROM fids_daily_rollup WHERE call_sign = $1`,
    [callSign],
  );
  return rows[0];
}

describe("replaceBoard's §17.3 rollup capture", () => {
  it("captures a fetched flight into fids_daily_rollup, keyed by its LA-local scheduled date", async () => {
    await replaceBoard("KSEA", [flight()]);

    const row = await rollupRow("ASA1234");
    expect(row).toMatchObject({
      airport_icao: "KSEA",
      direction: "arrival",
      call_sign: "ASA1234",
      flight_number: "AS1234",
      airline_name: "Alaska Airlines",
      status: "Expected",
      other_name: "San Francisco Intl",
    });
    expect(row!.date.toISOString().slice(0, 10)).toBe("2026-08-14");
  });

  it("survives the next refresh's DELETE + re-INSERT of fids_flights — the entire point of this table", async () => {
    await replaceBoard("KSEA", [flight()]);
    // A later refresh where this flight has aged out of the ~12h board
    // window entirely (an empty flights array, same as a real DELETE-only
    // refresh) must not remove it from the permanent rollup.
    await replaceBoard("KSEA", []);

    const boardRow = await pool.query("SELECT 1 FROM fids_flights WHERE call_sign = $1", ["ASA1234"]);
    expect(boardRow.rows).toHaveLength(0);

    const row = await rollupRow("ASA1234");
    expect(row).toBeDefined();
  });

  it("upserts a growing delay across repeated refreshes rather than only keeping the first sighting", async () => {
    await replaceBoard("KSEA", [flight({ status: "Expected", revisedTime: SCHEDULED })]);
    const delayedRevised = "2026-08-14T18:47:00.000Z"; // 47 min later
    await replaceBoard("KSEA", [flight({ status: "Delayed", revisedTime: delayedRevised })]);

    const row = await rollupRow("ASA1234");
    expect(row!.status).toBe("Delayed");
    expect(row!.revised_time!.toISOString()).toBe(delayedRevised);
  });

  it("skips capturing a flight with no scheduled time — there's no LA calendar date to bucket it under", async () => {
    await replaceBoard("KSEA", [flight({ callSign: "NOSKED1", scheduledTime: null })]);
    expect(await rollupRow("NOSKED1")).toBeUndefined();
  });

  it("keys rollup rows per airport, so the same call sign at two airports doesn't collide", async () => {
    await replaceBoard("KSEA", [flight({ direction: "arrival" })]);
    await replaceBoard("KPAE", [flight({ direction: "departure" })]);

    const { rows } = await pool.query(
      "SELECT airport_icao, direction FROM fids_daily_rollup WHERE call_sign = 'ASA1234' ORDER BY airport_icao",
    );
    expect(rows).toEqual([
      { airport_icao: "KPAE", direction: "departure" },
      { airport_icao: "KSEA", direction: "arrival" },
    ]);
  });
});
