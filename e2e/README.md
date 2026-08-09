# e2e

Playwright specs against the composed app (frontend + api + websocket), seeded deterministically instead of depending on live OpenSky polling — see `fixtures/seed.ts` for why `ingestion` is deliberately left out of the stack below.

## Running locally

```
docker compose up -d --build postgres redis api websocket frontend   # from the repo root — ingestion omitted on purpose
cd e2e
npm install
npx playwright install chromium   # first time only
npm run seed
npm test
```

**Timing matters**: `npm run seed` writes the live aircraft into Redis with the same TTL (`redisKeyTtlSeconds`, ~90s) ingestion's real writes use — a couple of missed polls and the key is considered stale, same as production. Run `npm run seed` immediately before `npm test`, not once at the start of a long local session; if more than ~90s pass between them, `map.spec.ts`'s aircraft-count assertions will fail because the seeded key genuinely expired, not because anything is broken. Postgres fixtures (the reference `aircraft` row, the seeded login user) don't expire — only the Redis-seeded live position does.

`docker compose down` between runs to fully reset; `down -v` if you also want a clean Postgres (its volume persists across `down`/`up`, unlike Redis's ephemeral container — `fixtures/seed.ts`'s Postgres writes are idempotent either way).
