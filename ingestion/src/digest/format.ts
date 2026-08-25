// Pure formatting/prompt-assembly for the nightly digest. Split out of
// generateDigest.ts (which runs main() on import, so nothing there is
// testable) — same script-vs-module split as backfillTrafficRollup.ts and
// db/trafficRollup.ts.

export interface NotableAircraft {
  icao24: string;
  registration: string | null;
  manufacturer: string | null;
  model: string | null;
  typecode: string | null;
  operator: string | null;
}

// §17.3 — one row per (date, airport, airline) captured into fids_daily_rollup.
export interface AirlineHighlight {
  airlineName: string;
  flights: number;
}

// §17.3 — shared identity fields for a single captured fids_daily_rollup
// flight, used by both the delay and diversion facts below.
export interface FlightHighlight {
  callSign: string;
  flightNumber: string | null;
  airlineName: string | null;
  airportIcao: string;
  direction: "departure" | "arrival";
  otherName: string | null;
}

export interface DelayHighlight extends FlightHighlight {
  delayMinutes: number;
}

export interface DigestStats {
  date: string;
  totalFlights: number;
  byAirport: Record<string, number>;
  // §17.1 — same-day-last-week comparison. null when there's no rollup row
  // 7 days back yet (e.g. too early in the project's history), not 0.
  vsLastWeek: number | null;
  // §17.1 — LA-local hour (0-23) with the most distinct aircraft, null if
  // the hourly rollup has no rows for this date.
  busiestHour: number | null;
  // §17.2 — aircraft whose *first-ever* sighting (aircraft.first_seen, which
  // is set once on insert and never updated — see insertPositions's ON
  // CONFLICT) falls on this date. Capped and restricted to rows with a
  // typecode so the digest always has something concrete to describe.
  notableAircraft: NotableAircraft[];
  // §17.3 — airline with the most fids_daily_rollup rows this date. null when
  // FIDS enrichment isn't configured (no AERODATABOX_API_KEY) or nothing was
  // captured yet.
  busiestAirline: AirlineHighlight | null;
  // §17.3 — largest positive (revised_time - scheduled_time) gap captured
  // this date. null when nothing qualifies as a genuine delay.
  longestDelay: DelayHighlight | null;
  // §17.3 — first captured flight this date whose status mentions a
  // diversion. null when none did.
  notableDiversion: FlightHighlight | null;
}

export interface DigestContent {
  headline: string;
  body: string;
  metaDescription: string;
}

export function todayLA(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
}

// Pure core of yesterdayLA(), split out so the month/year/leap-day rollovers
// are testable without freezing the clock. Goes through Date.UTC rather than
// local-time arithmetic so a DST shift in the *runner's* zone can't move the
// result — the input is already an LA-local calendar date, not an instant.
export function previousDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d) - 86_400_000);
  return `${yesterday.getUTCFullYear()}-${String(yesterday.getUTCMonth() + 1).padStart(2, "0")}-${String(yesterday.getUTCDate()).padStart(2, "0")}`;
}

// Mirrors index.ts's todayLA()/yesterdayLA() exactly.
export function yesterdayLA(): string {
  return previousDay(todayLA());
}

// 15 -> "3PM-4PM". Hours are already LA-local (traffic_hourly_counts.hour),
// so this is just formatting, no timezone conversion.
export function formatHourRange(hour: number): string {
  const to12h = (h: number) => {
    const period = h < 12 ? "AM" : "PM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}${period}`;
  };
  return `${to12h(hour)}-${to12h((hour + 1) % 24)}`;
}

// null when there's no rollup row from a week ago yet — the digest omits the
// comparison entirely rather than presenting it as a genuinely quiet week.
export function formatWeekComparison(stats: DigestStats): string | null {
  if (stats.vsLastWeek === null) return null;
  const delta = stats.totalFlights - stats.vsLastWeek;
  if (delta === 0) return `Same as this day last week (${stats.vsLastWeek} flights).`;
  const direction = delta > 0 ? "Up" : "Down";
  const pct = stats.vsLastWeek > 0 ? Math.round((Math.abs(delta) / stats.vsLastWeek) * 100) : null;
  return `${direction} ${Math.abs(delta)} flights${pct !== null ? ` (${pct}%)` : ""} vs. the same day last week (${stats.vsLastWeek} flights).`;
}

export function formatNotableAircraft(list: NotableAircraft[]): string | null {
  if (list.length === 0) return null;
  return list
    .map((a) => {
      const desc = [a.manufacturer, a.model].filter(Boolean).join(" ") || a.typecode;
      const reg = a.registration ? ` (${a.registration})` : "";
      const op = a.operator ? `, operated by ${a.operator}` : "";
      return `${desc}${reg}${op}`;
    })
    .join("; ");
}

export function formatAirlineHighlight(h: AirlineHighlight): string {
  return `${h.airlineName} (${h.flights} flight${h.flights === 1 ? "" : "s"})`;
}

// Shared by the delay and diversion lines below: "<airline> flight <num>
// arriving at/departing KSEA[ from/to <other airport>]".
function formatFlightRef(h: FlightHighlight): string {
  const airline = h.airlineName ? `${h.airlineName} ` : "";
  const flight = h.flightNumber ?? h.callSign;
  const verb = h.direction === "arrival" ? "arriving at" : "departing";
  const other = h.otherName ? ` ${h.direction === "arrival" ? "from" : "to"} ${h.otherName}` : "";
  return `${airline}flight ${flight} ${verb} ${h.airportIcao}${other}`;
}

export function formatDelayHighlight(h: DelayHighlight): string {
  return `${formatFlightRef(h)}, ${h.delayMinutes} min behind schedule`;
}

export function formatDiversionHighlight(h: FlightHighlight): string {
  return `${formatFlightRef(h)}, diverted`;
}

// Extra facts are appended as their own lines only when real data backs
// them — an absent line means "don't mention this," not "mention it as
// zero/unknown," matching loadStats()'s existing REGION-row guard. This is
// the grounding boundary: a fact the model is never shown is a fact it
// cannot be asked to describe, which is a stronger guarantee than the
// prompt's own "never mention X that isn't listed above" instruction.
export function buildExtraFacts(stats: DigestStats): string {
  const busiestHourLine =
    stats.busiestHour !== null
      ? `Busiest hour: ${formatHourRange(stats.busiestHour)} (most distinct aircraft observed).`
      : null;
  const notableAircraftLine = formatNotableAircraft(stats.notableAircraft);
  const busiestAirlineLine = stats.busiestAirline
    ? `Busiest airline: ${formatAirlineHighlight(stats.busiestAirline)}.`
    : null;
  const longestDelayLine = stats.longestDelay ? `Longest delay: ${formatDelayHighlight(stats.longestDelay)}.` : null;
  const notableDiversionLine = stats.notableDiversion
    ? `Notable diversion: ${formatDiversionHighlight(stats.notableDiversion)}.`
    : null;

  return [
    formatWeekComparison(stats),
    busiestHourLine,
    notableAircraftLine ? `First-ever tracked today: ${notableAircraftLine}` : null,
    busiestAirlineLine,
    longestDelayLine,
    notableDiversionLine,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function buildPrompt(stats: DigestStats): string {
  const airportLines = Object.entries(stats.byAirport)
    .map(([icao, flights]) => `${icao}: ${flights} flights`)
    .join("\n");

  const extraFacts = buildExtraFacts(stats);

  return `You are writing a short daily traffic digest for PugetScope, a live aircraft tracker for the Puget Sound region (Seattle-Tacoma Intl, Paine Field, Boeing Field, Renton Municipal, Tacoma Narrows).

Yesterday (${stats.date}) traffic, from ADS-B position data:
Region-wide: ${stats.totalFlights} distinct aircraft
${airportLines}
${extraFacts ? `\n${extraFacts}` : ""}

Write:
- headline: a short, specific news-style headline (under 12 words), using the actual numbers. Prefer the most striking fact available (a big week-over-week swing or a notable first-time aircraft), but only if one of those lines is present above.
- body: 2-4 sentences of plain factual prose describing the day's air traffic based only on these numbers. No speculation beyond what the numbers show, and never mention a comparison, busiest hour, aircraft, airline, delay, or diversion that isn't explicitly listed above. No markdown.
- metaDescription: one sentence (under 160 characters) summarizing the day, suitable for an HTML meta description tag.`;
}
