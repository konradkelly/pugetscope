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
- **Flight routing enrichment** (origin/destination + self-computed ETA per aircraft) — fully designed, see §12. First v2 feature to build.
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

- **Frontend**: React, TypeScript, Vite, MapLibre GL JS (OpenStreetMap tiles — open source, no vendor lock-in), Tailwind CSS. Aircraft icons: **placeholder single triangle glyph** (rotated by heading), chosen over tar1090's per-type icon set after checking — those icons are inline SVG path data in `markers.js`, covered by the *same* GPLv2+ license as the whole repo (no separate permissive per-asset license), which would mean real copyleft exposure if copied into PugetScope's own source tree. Not worth the licensing entanglement for a portfolio project. Revisit later with either a permissively-licensed (MIT/CC0) per-type icon set or custom-drawn icons if more visual variety is wanted.
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

**Managed vs. self-hosted Postgres/Redis (under consideration, not yet decided):** Phase 1 as built uses RDS (Postgres+PostGIS) and ElastiCache (Redis) — managed services, ~$26/mo combined (db.t4g.micro + cache.t4g.micro). The alternative is running both as K8s pods on the existing EC2 worker node(s), backed by EBS PersistentVolumes — which is exactly what Phase 0's `postgres-deployment.yaml`/`redis-deployment.yaml` already do locally, just extended into the EC2 cluster instead of swapped for managed services. Since the node compute is already paid for, the marginal cost there is closer to $3–4/mo (EBS storage only), roughly $20/mo cheaper. Tradeoff: RDS/ElastiCache provide backups, patching, and failover for free; self-hosted means owning PITR/backup scripts and disk-failure recovery. Arguably more consistent with this project's own thesis (self-managed K8s over EKS — operate infra yourself rather than lean on managed services), but that's a real ops-surface increase, not a free upgrade. Revisit before or during Phase 2.

## 10. Open Questions

- Managed (RDS/ElastiCache) vs. self-hosted (K8s pods on EC2 workers) for Postgres/Redis — see cost/tradeoff note above in §9. Leaning toward self-hosted for cost + thesis-consistency, not yet committed.

Otherwise resolved (see decisions inline above): manifest management, cluster HA staging, aircraft reference enrichment source, aircraft icon licensing, domain/hosting budget.

## 11. Next Steps

Progress against the original plan (repo: [github.com/konradkelly/pugetscope](https://github.com/konradkelly/pugetscope)):

1. ~~Scaffold repo structure~~ — done, monorepo (`frontend/`, `api/`, `ingestion/`, `websocket/`, `k8s/`, `terraform/`, `docs/`).
2. ~~Stand up `ingestion` service~~ — done, polling OpenSky every 30s, writing Redis + Postgres/PostGIS, verified against live traffic.
3. ~~Build `api` + `websocket` services~~ — done: hand-rolled auth (`api`), live position push via Redis pub/sub (`websocket`), both verified end-to-end.
4. ~~Build frontend map against live WebSocket feed~~ — done: live map, aircraft detail panel, auth UI, verified in-browser against the real pipeline.
5. ~~Aircraft reference data enrichment~~ — done: one-off `npm run enrich` job in `ingestion/`, verified against the live OpenSky Aircraft Database CSV.
6. ~~Containerize all four services + local k3d deploy~~ — done: Dockerfiles for all services, raw YAML manifests in `k8s/base/`, nginx-ingress (Traefik disabled), local image registry, verified end-to-end in-browser through the Ingress. See `k8s/README.md`.
7. ~~Terraform + cloud infra~~ — done: VPC (public subnets for K8s nodes, private for RDS/ElastiCache, no NAT gateway), RDS Postgres, ElastiCache Redis, 4 ECR repos, EC2 instance role + GitHub Actions OIDC role, and 2 EC2 nodes (1 control-plane + 1 worker) with containerd/kubeadm/kubelet pre-installed via user-data — applied live to AWS (us-west-2). See `terraform/README.md`. `kubeadm init`/`join` deliberately not run yet — that's Phase 2.
8. ~~Self-managed K8s on EC2 via kubeadm~~ — done: kubeadm-bootstrapped cluster (1 control-plane + 1 worker, Flannel CNI, baremetal/NodePort ingress-nginx) on the Phase 1 nodes, all via SSM (no SSH key exists on these instances by design). `k8s/` restructured to Kustomize (`base/` + `overlays/{local,ec2}`, with in-cluster Postgres/Redis pulled out into an opt-in `base/datastores` Component so `overlays/ec2` can use RDS/ElastiCache while `overlays/local` keeps k3d's in-cluster datastores — keeps the §9/§10 managed-vs-self-hosted question genuinely open). App deployed and reachable at a temporary nip.io hostname; RDS schema bootstrapped via a one-off Job (Terraform can't run SQL); ECR image pulls need their own refreshed pull secret (self-managed kubelet has no built-in ECR credential provider, unlike EKS). See `k8s/README.md` "EC2 cluster" section for full details, including two things surfaced during this pass and *not yet resolved*: (1) OpenSky Network appears to block AWS IP ranges — `ingestion` reaches RDS/Redis fine but its OpenSky polls time out, verified at the node level, so no live aircraft data flows through this deployment yet; (2) the EC2 Terraform user-data was missing `conntrack`/`ebtables`/`socat` (kubeadm preflight deps, fixed in `terraform/modules/ec2/templates/node-init.sh.tpl` for future nodes) — installed by hand on the two live nodes, but applying that Terraform fix now would replace both running nodes (`user_data_replace_on_change = true`), so it's deliberately *not* applied yet.
9. Multi control-plane HA rebuild (deliberate later milestone, per §9).

First v2 feature (independent of the infra track above): **flight routing enrichment**, fully specced in §12.

## 12. Flight Routing Enrichment (v2 — partially built)

Goal: show, per aircraft, where it departed from, where it's going, and an estimated arrival time. This is the routing/schedule layer OpenSky's live `/states/all` feed lacks.

**Build status:**
- ✅ **adsbdb origin/dest/airline enrichment** — built (`ingestion/src/enrichment/`), cached in `flight_routes`, folded into the Redis blob, surfaced in the frontend detail panel with a confidence-keyed disclaimer.
- ✅ **Plausibility suppression + route confidence field** — built. A cached route contradicted by direct observation is dropped rather than shown.
- ✅ **Own-track inference (tier 2)** — built (`regionalAirports.ts`, `attachRoutes.ts`). A landing/departing aircraft near a regional airport gets a partial `"inferred"` route (the observed endpoint only) whenever adsbdb's route is missing or contradicted; an adsbdb route that agrees with the observation is left as `"typical"` rather than needlessly overwritten. Verified live: 15/16 phase-matched aircraft in one poll went from no-route-or-suppressed to a real inferred endpoint.
- ✅ **FIDS match (tier 1, AeroDataBox)** — built (`fidsClient.ts`, `db/fidsFlights.ts`, `fidsRefreshWorker.ts`). SEA-only, checked highest-priority in `attachRoutes`. Confirmed endpoint details directly from AeroDataBox's OpenAPI spec: `GET /flights/airports/icao/{icao}/{fromLocal}/{toLocal}`, TIER 2 pricing (2 units/call), free BASIC plan = 600 units/mo = 300 calls/mo. Refresh cadence set to every 3h (8 calls/day, ~240/mo) to stay well under budget; a persisted `fids_refresh_state.last_fetched_at` means a service restart never resets the cadence or causes a fetch burst. adsbdb's `airline` field is unused when a FIDS match exists — FIDS's own live `airline` is preferred. Also delivers **real ETA** for arrivals (FIDS's `revisedTime` — an actual live estimate, not the haversine calc below), surfaced as `route.eta`. Verified (parsing/caching/matching logic against a realistic mocked response, since a real API key requires a RapidAPI signup only the user can do): the exact `DAL889` case that opened this whole investigation (observed landing at SEA, cached adsbdb route wrongly said `PDX→JFK`) now resolves to `PDX→KSEA`, `confidence: "live"`, with a real ETA.
- ⬜ **Self-computed haversine ETA** (fallback for tiers 2/3, when no FIDS match) — designed below, not yet built.

### Data source: free callsign→route lookup (not the paid schedule APIs)

Primary: **adsbdb.com** — free, no account, clean JSON. Given a callsign (which `/states/all` already provides, e.g. `ASA415`) it returns origin + destination airports with ICAO/IATA codes, names, **and coordinates**, plus airline. Endpoint: `https://api.adsbdb.com/v0/callsign/{CALLSIGN}`. Fallback: **hexdb.io** (`https://hexdb.io/callsign-route?callsign={CALLSIGN}`) if adsbdb 404s.

**Key limitation (accepted):** these are crowd-sourced route databases returning the route a callsign *typically* flies (keyed by flight number), not the live routing of the specific in-progress flight — and different providers can disagree (observed: adsbdb said ASA415 = LAX→SEA, hexdb said SAN→SEA). No live ETA, gate, or delay data. That's the tradeoff for $0/no-account. If authoritative live schedule/ETA/gate data is ever needed, **FlightAware AeroAPI** (~$99/mo Silver tier for our query volume) is a drop-in supplement — the caching architecture below is identical either way, so it's a swap of one enrichment module, not a rearchitect. Cost math for AeroAPI: naive per-poll-per-aircraft lookups would be ~86k queries/day (ruinous); the callsign-keyed cached design below collapses that to ~one lookup per unique flight (few hundred–1k/day), which is what keeps it in the cheap tier.

### ETA — computed ourselves, free

The route lookup gives the **destination airport's coordinates**; OpenSky already gives the aircraft's live position + ground speed. So ETA is derived locally:
`eta_seconds = haversine(current_pos, destination_coords) / ground_speed`, `eta_time = now + eta_seconds`. Guard against near-zero ground speed (on-ground/taxiing → no ETA). Recompute at **read time** (see below), not stored — so it refines automatically as the aircraft nears its destination, at zero API cost and never going stale. Label it clearly as an estimate in the UI: it ignores approach patterns, holding, and taxi time and assumes a direct constant-speed path.

### Data model additions

```sql
-- cached route lookups, keyed by callsign (a flight number, e.g. ASA415)
flight_routes(
  callsign        TEXT PRIMARY KEY,
  origin_icao      TEXT, origin_iata TEXT, origin_name TEXT,
  origin_lat       DOUBLE PRECISION, origin_lon DOUBLE PRECISION,
  dest_icao        TEXT, dest_iata TEXT, dest_name TEXT,
  dest_lat         DOUBLE PRECISION, dest_lon DOUBLE PRECISION,
  airline_name     TEXT,
  found            BOOLEAN NOT NULL,   -- negative-cache misses (GA/military callsigns) too
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

Caching is by callsign with a long TTL (routes change slowly, and the source data is itself "typical route" not per-instance, so a multi-day/week cache matches its own semantics). `found = false` rows negative-cache misses with a *shorter* TTL so we don't re-hammer the free API for the large volume of GA/military callsigns that will never resolve.

### Where it slots in — decoupled from position polling

Same principle as the existing aircraft-reference enrichment (§7): **never call the external API from the poll loop**. Flow:
1. Ingestion poll sees an aircraft with a callsign.
2. Look up `flight_routes` in Postgres (local join). Hit → attach route to the enriched record written to Redis. Miss/stale → enqueue an async lookup, don't block the poll.
3. A lightweight in-process lookup worker (own rate limit; be a good citizen to a volunteer-run API — set a `User-Agent`, cap lookups/min, back off on errors) calls adsbdb → hexdb fallback → upserts `flight_routes` (including negative results). If both are down, serve stale cache; never crash ingestion.
4. Route fields (incl. destination coords) get written into the `aircraft:latest:{icao24}` Redis blob so the API and WebSocket serve them without extra work.

Start this worker in-process inside `ingestion`; note it's a clean candidate to split into its own `enrichment` microservice later (matches the §5 microservices direction) if lookup volume warrants.

**ETA computed at read time**, not stored: the `api` service's `GET /aircraft/:icao24` (and the enriched blob the `websocket` service pushes) compute `eta_time` on the fly from the record's current position + cached destination coords. Frontend can equally compute it client-side from the same fields — either is fine; read-time keeps it always-fresh with zero storage or refresh cost.

### API surface additions
- `GET /aircraft` and `GET /aircraft/:icao24`: add `origin`, `destination`, and computed `eta` fields.
- WebSocket `/live` blobs: include `origin`/`destination` so the map can label/draw routes; `eta` computed client-side or server-side at emit.

### Licensing / dependency note
adsbdb is open-source (MIT) with a free public API; hexdb similarly free. Both are volunteer-run — hence the aggressive caching, negative-caching, and self-rate-limiting above. If volume ever outgrows polite use, adsbdb publishes data dumps that could be self-hosted as a fallback.

### Routing accuracy upgrade (all three tiers + plausibility suppression built)

**Problem the current build has.** adsbdb/hexdb return the route a callsign *typically* flies, not what the specific in-progress aircraft is doing. Observed live: `DAL889` descending into SEA (175 m, sinking, over Renton) but cached as PDX→JFK — plainly wrong for that airframe. Other free live-ADS-B APIs (airplanes.live, adsb.fi, adsb.lol, ADSB One) were checked and use the *same* crowd-sourced route DBs, so switching providers doesn't help. Fixing this needs either our own track data or a real schedule source.

**Design: a confidence-tiered hybrid.** Resolve each aircraft's route through tiers, highest confidence first, and label the result's confidence in the UI:

1. **FIDS match — authoritative, "live" (✅ built, `ingestion/src/enrichment/fidsClient.ts` + `db/fidsFlights.ts` + `fidsRefreshWorker.ts`).** Pulls the live arrivals + departures board for SEA (single airport for now — see below) and matches the aircraft's callsign against *today's actual* flights via **AeroDataBox** on RapidAPI (`GET /flights/airports/icao/{icao}/{fromLocal}/{toLocal}`, confirmed directly from their OpenAPI spec). `callSign` is returned on every flight and is a direct join key against OpenSky's callsign — no fuzzy matching needed. `movement.airport` already resolves to the *opposite-end* airport of that leg (destination for a departure, origin for an arrival), and `movement.revisedTime` is a real live actual/estimated time — surfaced as `route.eta` for arrivals.

   **Real cost math (this is TIER 2, not the always-free tier):** 2 units/call, free BASIC RapidAPI plan = 600 units/mo = **300 calls/mo**. For one airport that's ~10 calls/day; refresh cadence set to every 3h (8 calls/day, ~240/mo) to leave headroom. A 12h-window-per-call limit means the fetch spans roughly `now - 3h` to `now + 9h`, weighted toward upcoming/recently-active traffic. `fids_refresh_state.last_fetched_at` is persisted so a service restart/redeploy never resets the cadence or causes a fetch burst — the worker checks every 5 min whether a refresh is *due*, rather than fetching on every boot. Started at **SEA only**; BFI/PAE/RNT would each need their own share of the 300/mo budget, so multi-airport is a deliberate later expansion, not a default. Bonus: the same board data would unlock the deferred "airport departures/arrivals dashboard" feature (§2 v2 backlog) if built out further.

   Gated on `AERODATABOX_API_KEY` being set (an optional env var, unlike OpenSky's required credentials) — without it, `attachRoutes` just falls through to tiers 2/3 as before, logged once at startup. Verified: parsing/caching/matching logic checked end-to-end against a realistic mocked AeroDataBox response (a real key requires a RapidAPI signup, which only the account owner can do) — the exact `DAL889` case that motivated this whole upgrade (observed landing at SEA, adsbdb wrongly cached as `PDX→JFK`) now resolves to `PDX→KSEA`, `confidence: "live"`, with a real ETA.

2. **Own-track inference — high confidence for the in-region endpoint (✅ built, `ingestion/src/enrichment/regionalAirports.ts` + `attachRoutes.ts`).** We are literally watching the aircraft: one descending toward a known regional airport (altitude falling, vertical rate negative, within ~15km, near-ground altitude) lets us assert its **destination** directly; one climbing out asserts its **origin**. No external source needed. Only the *far* endpoint (where an arrival originally came from / where a departure ultimately terminates) is left unknown (`null`) unless a route lookup separately corroborates it — implemented as a partial route (one endpoint populated, the other `null`), rather than inventing a value for the unobserved side. An adsbdb route that *agrees* with the observed endpoint is left as `"typical"` (not overwritten) since it may still carry the far endpoint adsbdb knows and inference doesn't. Verified live against real traffic: 15 of 16 aircraft matching a landing/departing phase in one poll went from no-route-or-suppressed to a genuine inferred endpoint (e.g. `N9655B` departing KPAE → `KPAE→?`), while a corroborating case (`SKW3802` landing KSEA, cached `KSJC→KSEA`) was correctly left as `"typical"` rather than needlessly narrowed.

3. **adsbdb typical route — low confidence, current behavior.** Keep as the fallback when neither above resolves (e.g. through-traffic overflying the region, not touching a local airport), labeled "typical / unconfirmed" exactly as now.

**Plausibility suppression (✅ built, free, no new source):** before trusting an adsbdb route, sanity-check it against the live track. If neither the cached origin nor destination matches what tier 2's geometry directly observes, the typical route is contradicted by what we can see — so it's dropped in favor of the tier-2 inferred partial route rather than displaying something known to be wrong. Verified live: 4 real contradictions caught (e.g. `ASA471` landing at KSEA while cached as `MMPR→KSAN`).

**Confidence field (✅ built).** `route.confidence` (`"live" | "inferred" | "typical"`) flows from `ingestion` through the Redis blob to the API/WebSocket and is rendered as a confidence-keyed disclaimer in the frontend detail panel, with `route.eta` (only present on a `"live"` arrival match) rendered as a countdown when available. This is the honest, portfolio-worthy framing: multi-source enrichment with explicit, surfaced confidence rather than a single unreliable lookup presented as fact.

**Remaining gap:** the haversine self-computed ETA (below) is still unbuilt, so tiers 2/3 (`"inferred"`/`"typical"`) have no ETA at all yet — only `"live"` FIDS matches do.

**Sequencing:** (1) plausibility suppression + `confidence` field (free, immediate), (2) own-track endpoint inference, (3) AeroDataBox FIDS integration + airport-board cache (also delivers the airport dashboard). ETA (above) composes cleanly on top — a FIDS-sourced estimated arrival time supersedes the self-computed haversine ETA when available.
