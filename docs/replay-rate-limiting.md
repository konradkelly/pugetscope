# Replay's rate-limit incident

What broke the first working version of Historical Playback (§16), how it was found, and the fix. Follow-up to the §16 spec itself — this covers a bug in the initial implementation, not a design change to it.

## The symptom

Scrubbing to an arbitrary past timestamp sometimes rendered the map with zero aircraft, even at a time of day (mid-afternoon) that should plainly have traffic. No error appeared anywhere — the scrubber looked exactly like a legitimate "nothing was flying right then" result.

## Root cause: a rate limit with no headroom over its own baseline load

`GET /replay/frame` (`api/src/routes/replay.ts`) originally shipped with `{ max: 60, timeWindow: "1 minute" }` — the same per-route override pattern as the other read-heavy analytics routes (`traffic.ts`, `analytics.ts`, `airports.ts`, all `20/min`). 60/min was chosen because active playback polls at roughly 1 request/second, and 60/min looks like it matches that 1:1.

That reasoning has a bug in it: matching the limit to the *exact* steady-state draw leaves zero room for jitter. Two things reliably pushed it over:

1. **Dragging the scrubber.** `ReplayScrubber`'s range `<input>` fires `onChange` continuously while the mouse moves, and each firing updated `currentMs` immediately — so one drag gesture across the bar produced a burst of distinct timestamps, each triggering its own `/replay/frame` fetch. Confirmed directly in the `api` container's request log: a single drag produced 7 requests inside under a second.
2. **Sustained playback with no slack.** Even with zero drags, continuous 1x/5x/20x playback alone sits at ~60 requests/min indefinitely (the scrubber ticks once per *real* second regardless of speed — see `useReplayPlayback.ts`; speed only changes how much sim-time each tick advances, not how often it fetches). A fixed-window limiter sitting exactly on that line means any timing jitter at all — a slightly-early tick, a retry, one extra request from initial load — tips it over, and once over, the limiter rejects requests for the rest of that window while the input rate keeps coming in at the same pace. It doesn't recover on its own; the next window starts the same way.

Checked directly against the running `api` container's logs from one ordinary test session:

```
329  200
  2  401   (unrelated — GET /auth/me, expected when logged out)
681  429
```

**681 of ~1010** `/replay/frame` requests were rejected. That's not an edge case — that's most requests, under normal use, not abuse.

The second half of the bug: `useReplayFeed`'s `.catch()` set an internal `error` state, but nothing ever rendered it — `ReplayScrubber` only ever read `aircraft`/`bounds`/`currentMs`/etc. A `429` and "genuinely no aircraft in this window" were visually indistinguishable to anyone looking at the map.

## The fix

Three changes, across `api/src/routes/replay.ts` and two frontend files:

1. **Real headroom on the limit** (`replay.ts`): raised to `{ max: 300, timeWindow: "1 minute" }`. The steady-state draw (~60/min while playing) now uses a fifth of the budget, leaving room for bursts from manual seeking without living on the edge of the window.
2. **Debounce the fetch trigger, not just the UI** (`useReplayFeed.ts`): the effect that calls `api.getReplayFrame()` now waits `DEBOUNCE_MS = 200` after `atMs` last changed before firing, clearing the pending timer if `atMs` changes again first. A drag gesture now produces exactly one request, for wherever the drag ends up, instead of one per intermediate mouse position. 200ms is comfortably shorter than the 1000ms real-time tick driving ordinary playback, so it adds no perceptible lag and never coalesces two genuinely distinct playback frames into one.
3. **Surface the error** (`ReplayScrubber.tsx`): a failed fetch now renders "Couldn't load this frame (…) — showing the last position that loaded" under the scrubber, instead of silently leaving whatever aircraft (or lack of aircraft) was already on screen.

None of this touches the query itself (`DISTINCT ON (icao24) ... WHERE recorded_at BETWEEN $1 AND $2`, still capped at `windowSeconds ≤ 180`) — the query was never the problem. Every one of the 681 rejected requests would have returned real data; they just never reached Postgres.

## Verified

Rebuilt `api`+`frontend`, then reran the exact failure mode in a headless browser (Playwright): a rapid full-range slider drag immediately followed by 8s of sustained 1x playback.

- Before the fix: 681/1010 requests over a session → `429`.
- After the fix, same drag-then-play pattern: **0/9** requests → `429`; all `200`.

Separately confirmed (direct SQL against the dev DB) that this local environment's `positions` table has a genuine 9-day gap with zero rows (2026-07-13 through 2026-07-20) — an artifact of the dev stack not running continuously, not a replay bug. Scrubbing into that range correctly shows "0 aircraft" with no error, same as scrubbing to a moment with truly no traffic would. That's the one case where an empty result *is* the honest answer, and it's now distinguishable from a rate-limited fetch by the absence of the error line.

## The general lesson

Sizing a rate limit against the *nominal* request rate of a polling feature — rather than against that rate plus realistic jitter/bursts — produces a limiter that's one hiccup away from rejecting normal traffic. This is a narrower version of the same class of mistake as under-provisioning any fixed-window counter: the useful question isn't "what's the expected load," it's "what's the expected load, plus how much room does normal variance need on top of it." A limit that sits exactly on its own baseline isn't a safety margin — it's a coin flip repeated once a minute forever, and 60/min against a load that's continuously trying to be exactly 60/min was never going to end well without a client-side fix (the debounce) *and* server-side slack (raising the cap) working together — either alone would have left the other failure mode in place.
