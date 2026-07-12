# PugetScope

Real-time aviation dashboard for the Puget Sound region (SEA, BFI, PAE, RNT, TIW, Whidbey NAS, JBLM).

See [docs/SPEC.md](docs/SPEC.md) for the full project spec: vision, scope, architecture, tech stack, and infra plan.

## Structure

- `frontend/` — React + TypeScript + Vite + MapLibre GL JS
- `api/` — REST API service (Fastify)
- `ingestion/` — ADS-B ingestion service (polls OpenSky, writes to Redis/Postgres)
- `websocket/` — Live position broadcast service
- `k8s/` — Kubernetes manifests (`base/` + environment `overlays/`)
- `terraform/` — AWS infrastructure as code
- `docs/` — Project spec and other documentation
