import { lookupCallsign } from "./adsbdbClient.js";
import { upsertRoute } from "../db/flightRoutes.js";

// Gentle, self-imposed rate limit against a volunteer-run API (docs/SPEC.md §12).
// The queue dedupes, and once a callsign is cached (hit or miss) it stops being
// re-enqueued, so steady-state lookups approach zero after the first pass.
const TICK_MS = 2000;
const LOOKUPS_PER_TICK = 5;

const pending = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

export function enqueueLookup(callsign: string): void {
  pending.add(callsign);
}

async function tick(): Promise<void> {
  if (pending.size === 0) return;

  const batch: string[] = [];
  for (const callsign of pending) {
    batch.push(callsign);
    pending.delete(callsign);
    if (batch.length >= LOOKUPS_PER_TICK) break;
  }

  await Promise.all(
    batch.map(async (callsign) => {
      try {
        const result = await lookupCallsign(callsign);
        await upsertRoute(callsign, result);
      } catch (err) {
        // Transient (network/5xx/rate-limit): leave uncached so the next poll
        // that still sees this callsign re-enqueues it. Don't negative-cache.
        console.warn(`[routes] lookup failed for ${callsign}, will retry:`, (err as Error).message);
      }
    }),
  );
}

export function startRouteLookupWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  console.log("[routes] lookup worker started");
}
