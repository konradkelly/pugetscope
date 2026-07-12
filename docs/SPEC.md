# PugetScope — v1 Spec

Domain: **pugetscope.com** (registered via Hostinger). App infrastructure (EC2, RDS, ElastiCache, etc.) hosted on AWS per §9 — Hostinger's role is domain registration/DNS only, not app hosting.

Status: draft. Living document — update as decisions change.

## 1. Vision

A real-time aviation dashboard focused on the Puget Sound region (SEA, BFI, PAE, RNT, TIW, Whidbey NAS, JBLM), built primarily as a portfolio project demonstrating depth in real-time data pipelines, geospatial systems, and cloud-native infrastructure. Optimize for **depth over breadth**: a small, polished feature set backed by a genuinely well-architected system beats a feature-sprawling demo.

Target audience: public multi-user web app — real accounts, not just a personal demo — because that's the harder, more realistic system to build and defend in an interview.

## 2. V1 Scope

### In scope
- **Live aircraft map** for the Puget Sound region: aircraft icons (heading-rotated), altitude-based coloring, position trails, live movement via WebSocket push (no polling).
- **Aircraft detail panel**: click an aircraft → callsign, registration, type, altitude, ground speed, heading, vertical speed, origin/destination if known.
- **Real-time ingestion pipeline**: dedicated ADS-B ingestion service, decoupled from the API service (see Architecture).
- **Accounts/auth**: real user accounts (signup/login), since this is a public multi-user app.
- **Kubernetes-native architecture from day one**: services are containerized and designed as independent Deployments even in the earliest local-dev version (via `k3d` locally — see Infra). Cloud target is **self-managed Kubernetes on EC2**, not EKS (cost — no EKS control-plane hourly charge — and it's the deeper "operate Kubernetes, not just use it" story for a portfolio project).

### Explicitly out of scope for v1 (candidates for v2+)
- Airport departures/arrivals dashboard (needs a schedule data source, separate integration)
- Flight playback/replay
- Noise heatmap
- Boeing Spotter Mode / rare-aircraft notifications
- Ferry/maritime integration
- Terrain/weather overlays
- AI features (NL search, delay prediction, daily summaries)
- Airport webcams, spotting checklist/badges

These stay in the idea backlog (see ChatGPT brainstorm) and get scoped in detail only once v1 is solid.

## 3. Region Definition

Puget Sound bounding box (approx, needs refinement):
- North: ~48.4°N (past Whidbey NAS)
- South: ~47.0°N (past JBLM/Tacoma Narrows)
- West: ~-123.2°W
- East: ~-121.9°W

Filtering happens in the ingestion service — pull global/regional OpenSky data and drop anything outside this box before it touches Redis/Postgres.

## 4. Data Source

**OpenSky Network** for v1 (free, open, REST + historical bulk data, no ongoing cost).

**Rate limits (confirmed)**: credits are tracked in three independent buckets (`/states/*`, `/tracks/*`, `/flights/*`). Anonymous access gets 400 credits/day (most-recent-only, 10s resolution, no history). A free **registered account** using OAuth2 client credentials gets 4,000 credits/day, up to 1hr of history, 5s resolution. `/states/all` bounding-box queries cost 1 credit for boxes ≤25 sq°.

Our Puget Sound bbox (§3) is ~1.8 sq°, so every poll costs 1 credit. Plan: **registered account, poll every 30s** (2,880 credits/day, well under the 4,000 budget, leaves headroom for retries/testing/other queries). Anonymous tier is not viable — 400 credits/day only supports a poll every ~3.6 min.

The API is poll-based, not push-based — the ingestion service owns the polling loop. On `429 Too Many Requests`, read the `X-Rate-Limit-Retry-After-Seconds` header and back off rather than hard-coding a retry delay.

Note: OpenSky's OAuth2 client credentials are a service-to-service API credential for the ingestion service, unrelated to the Arctic-based end-user OAuth login (§6 Auth).

## 5. Architecture

Microservices, each an independent container/K8s Deployment:

```
OpenSky API
     │  (poll)
     ▼
ADS-B Ingestion Service ──► PostgreSQL + PostGIS (history)
     │                            ▲
     ▼                            │
   Redis (latest positions) ──────┘
     │
     ▼
WebSocket Service ──► React frontend (live map)
     │
API Service ──► Redis (latest) + Postgres (detail/auth/users)
     │
React Frontend ──► REST calls for aircraft detail, auth
```

Services:
| Service | Responsibility |
|---|---|
| `ingestion` | Poll OpenSky, filter to Puget Sound bbox, dedupe, write latest state to Redis, append history to Postgres |
| `api` | REST endpoints: aircraft list/detail, auth (signup/login/session), user preferences |
| `websocket` | Subscribes to Redis updates, pushes live position deltas to connected browser clients |
| `frontend` | React + TypeScript + MapLibre GL JS map, aircraft detail panel, auth UI |

Why split ingestion from API: ingestion is a long-lived, always-on process independent of user traffic; API needs to scale independently with request load and shouldn't compete with the feed connection for resources.

## 6. Tech Stack

- **Frontend**: React, TypeScript, Vite, MapLibre GL JS (OpenStreetMap tiles — open source, no vendor lock-in), Tailwind CSS. Aircraft icons: **tar1090's SVG icon set** (per-type icons — jet/helicopter/military/etc., designed for heading rotation, used by the real hobbyist ADS-B tracking community) — GPLv2+ repo, confirm the icon files' own license header before pulling them in; fallback is Bootstrap Icons (MIT) generic airplane glyph if that check doesn't come back clean.
- **Backend**: Node.js, Fastify, WebSockets (`ws` or Fastify's websocket plugin)
- **Database**: PostgreSQL + PostGIS extension (aircraft history, users, region metadata)
- **Cache**: Redis (latest aircraft positions, session/rate-limit data)
- **Auth**: Hand-rolled sessions — `argon2` for password hashing, random 32-byte session tokens (`crypto.randomBytes`) stored in Redis with expiry, httpOnly/Secure/SameSite cookies; Postgres holds the user record. OAuth (Google/GitHub) via **Arctic** (minimal, framework-agnostic OAuth client — same author as the now-deprecated Lucia) for the handshake only; both local login and OAuth callbacks terminate in the same session-creation function. Decided against Passport.js (Express-shaped, needs an adapter for Fastify) and against a full auth framework like Auth.js (too framework-opinionated, less to explain in an interview).
- **Containerization**: Docker for every service from day one
- **Orchestration**: Kubernetes — local dev via **k3d** (chosen over kind/minikube: fastest iteration loop, built-in LoadBalancer + local registry, k3s is a real production-grade distro so the experience transfers); cloud via **self-managed K8s on EC2 via kubeadm** — no EKS, to avoid the control-plane cost and to own cluster administration end to end. Pin an explicit ingress controller (e.g. nginx-ingress) in k3d rather than relying on its default Traefik, so manifests stay portable to the EC2 cluster.
- **IaC**: Terraform for AWS resources (VPC, EC2 instances for K8s nodes, RDS, ElastiCache, IAM)
- **CI/CD**: GitHub Actions — build/push images, run tests, apply Terraform, deploy manifests

## 7. Data Model (sketch — Postgres/PostGIS)

```sql
-- users
users(id, email, password_hash, created_at)

-- aircraft (static/reference info, batch-loaded — see Aircraft Reference Data below)
aircraft(icao24 PK, registration, model, operator, manufacturer, typecode, first_seen, last_seen)

-- position history (PostGIS geography column)
positions(id, icao24 FK, position GEOGRAPHY(POINT), altitude, ground_speed,
          heading, vertical_speed, callsign, recorded_at)
-- indexed on (icao24, recorded_at) and GiST on position

-- user_preferences (v1: minimal — maybe just saved map view / theme)
user_preferences(user_id FK, key, value)
```

Redis keys: `aircraft:latest:{icao24}` → JSON blob of current state, TTL-refreshed on each ingestion write; a set/index of currently-active icao24s for the region.

**Aircraft reference data enrichment decision**: primary source is the **OpenSky Aircraft Database** (community-compiled CSV, `icao24` → registration/manufacturer/model/typecode/operator; aggregates FAA + other national registries, so it isn't US-only). It updates irregularly (periodic snapshots) — not a live API — so it's loaded via a **scheduled batch job** (e.g. monthly) that downloads the CSV and upserts into the `aircraft` table, not queried per-poll by the ingestion service. FAA registry data is a fallback/supplement specifically for US-registered aircraft (most of SEA/BFI/PAE traffic) if an `icao24` is missing from the OpenSky DB or looks stale. The ingestion service only ever does a local Postgres join on `icao24` — it never calls out to either registry directly.

## 8. API Surface (v1 draft)

```
POST /auth/signup
POST /auth/login
POST /auth/logout
GET  /auth/me

GET  /aircraft            # current positions in region (from Redis)
GET  /aircraft/:icao24    # detail (Redis latest + Postgres history/reference)

WS   /live                # subscribe to live position deltas
```

## 9. Infra Phasing

Since the decision is to design for Kubernetes from the start, but the app itself doesn't exist yet, and the cloud target is self-managed K8s on EC2 (not EKS):

1. **Phase 0 — Local K8s**: All services containerized, deployed to a local `k3d` cluster via **raw YAML manifests** (chosen deliberately since this is a first Kubernetes project — see Manifest Management below) from the first working version. Postgres/Redis can run as StatefulSets or simple Deployments locally. Explicit nginx-ingress installed (not k3d's default Traefik) to keep manifests portable, applied as the vendor's raw manifest via `kubectl apply -f`.
2. **Phase 1 — Cloud infra via Terraform**: VPC, EC2 instances (for K8s nodes), RDS (Postgres+PostGIS), ElastiCache (Redis), ECR for images, IAM. No cluster yet — validate infra pieces independently.
3. **Phase 2 — Self-managed K8s on EC2** (kubeadm — chosen over k3s for closer fidelity to vanilla upstream Kubernetes and deeper transferable knowledge of cluster internals): provision via Terraform, bootstrap the cluster, deploy the same manifests from Phase 0. This is the production target — no EKS migration planned. Start with a **single control-plane node** (see Cluster HA decision below). With two real environments (local + EC2) now in play, introduce **Kustomize** here (`base/` + `overlays/{local,ec2}`) to manage the config diff, rather than earlier — by this point the raw-YAML foundation from Phase 0 is understood well enough that Kustomize's patches are legible rather than another layer of unknowns.
4. **Phase 3 — Multi control-plane HA** (later milestone, not required for v1): rebuild the EC2 cluster with 3 control-plane nodes, etcd quorum, and a load balancer/VIP (e.g. `kube-vip`) in front of the API servers. Deliberately sequenced after Phase 2 rather than done upfront — single control-plane needs to be understood first so HA is a deliberate upgrade with known tradeoffs, not a tutorial followed blind.

**Cluster HA decision**: Single control-plane node for the initial EC2 cluster (Phase 2) — cheaper (one fewer EC2 instance, no load balancer needed), and simpler to bootstrap with kubeadm while still learning fundamentals. Multi-control-plane HA (3 nodes, etcd quorum, load-balanced API server) deferred to Phase 3 as a deliberate follow-up milestone once single control-plane operation is well understood. Tradeoff accepted for Phase 2: a control-plane node failure would make the cluster unmanageable (though already-running pods keep serving traffic until they themselves fail).

**Manifest management decision**: Raw YAML first (Phase 0), Kustomize introduced in Phase 2 once there's a real multi-environment need to justify it. Rationale: this is a first Kubernetes project — learning to read patched/overlaid manifests at the same time as learning the underlying K8s objects makes debugging ambiguous (is the bug in my understanding of the Deployment, or in the overlay?). Writing raw manifests first means every debugging session teaches Kubernetes itself. Helm reserved for third-party charts only (ingress controller, etc.), not the app's own manifests, and only introduced once actually needed.

CI/CD: GitHub Actions builds images on push, pushes to ECR, applies Terraform on infra changes, applies K8s manifests on app changes (separate pipelines).

## 10. Open Questions

- **tar1090 icon license verification**: confirm the icon SVG files' own license terms before adoption (repo is GPLv2+ overall; asset-specific terms should be checked directly).

**Domain/hosting budget decision**: No fixed spend ceiling — comfortable proceeding within current AWS and Hostinger costs. Not a blocker for infra sizing decisions (EC2 instance count/size, RDS, ElastiCache).

## 11. Next Steps

1. Resolve remaining open questions above (domain/hosting budget, tar1090 icon license check).
2. Scaffold repo structure (monorepo vs. multi-repo per service — TBD).
3. Stand up `ingestion` service against OpenSky with regional filtering, writing to local Postgres/Redis — validate the data pipeline before touching the frontend.
4. Build `api` + `websocket` services against that data.
5. Build frontend map against live WebSocket feed.
6. Containerize + local K8s deploy.
7. Terraform + cloud infra.
