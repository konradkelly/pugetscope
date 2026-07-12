# PugetScope frontend

React + TypeScript + Vite + MapLibre GL JS. See [../docs/SPEC.md](../docs/SPEC.md) for the full project spec.

## Dev setup

```
cp .env.example .env
npm install
npm run dev
```

Requires the `api` service on port 3000 and the `websocket` service on port 3001 running (see their `.env.example` files) for live data and auth to work.
