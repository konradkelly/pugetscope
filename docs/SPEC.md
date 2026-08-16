# PugetScope — v1 Spec

Domain: **pugetscope.com** (registered via Hostinger; DNS delegated to a Route 53 hosted zone — `terraform/modules/route53` — Hostinger's role is now purely registrar). App infrastructure (EC2, RDS, ElastiCache, etc.) hosted on AWS per §9. Live at **https://pugetscope.com/** (TLS via cert-manager + Let's Encrypt).

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
- Airport departures/arrivals dashboard (needs a schedule data source, separate integration) — partially unblocked already: FIDS (§12) already pulls this data for route-matching, just not surfaced as its own public-facing view. Built — see `api/src/routes/airports.ts`, `AirportBoardPanel.tsx`; see §14.
- Flight playback/replay — the `positions` table has been accumulating full history (position/altitude/speed/heading per aircraft per poll) since ingestion went live; this is a query/UI problem against data already collected, not a new integration. Built — see `api/src/routes/replay.ts`, `useReplayFeed.ts`/`useReplayPlayback.ts`, `ReplayScrubber.tsx`; see §16.
- Noise/overflight analytics by neighborhood — buckets overflights by neighborhood/zip polygon × time-of-day × altitude, using data already in `positions`. No new data source needed. Built — see `api/src/routes/analytics.ts`, `NeighborhoodAnalyticsPanel.tsx`; see §13.
- Traffic volume analytics — flights/hour, busiest times of day, day-of-week patterns, split by airport (KSEA vs. the 4 regional fields). Same `positions` table, aggregate rather than per-neighborhood. Built — see `api/src/routes/traffic.ts`, `TrafficVolumePanel.tsx`, and `docs/rollup-tables.md` for the pre-aggregation design this ended up needing.
- Runway/flow-direction inference — which configuration SEA is using right now, inferred from approach/departure headings already in `positions`. Feeds both the noise-analytics angle and general spotter interest. Built — see `ingestion/src/enrichment/flowDirection.ts`, `FlowBadge.tsx`; see §15.
- Aircraft/airline mix stats — busiest operator this week, rarest type spotted; leaderboard-flavored, builds on the reference-data enrichment already built (registration/manufacturer/model/operator, `ingestion/src/enrichment/`). Specced, see §19.
- Boeing Spotter Mode / rare-aircraft notifications. Specced, see §20.
- Personal spotting log (auth-gated) — auto-confirmed against real ADS-B data rather than self-reported. Built — see `api/src/routes/spottings.ts`, `SpottingLogPanel.tsx`.
- Saved watchlist + custom alert zones (auth-gated) — "notify me when N123AB is back in the area" / "notify me when something's over my house." Built — see `api/src/routes/alerts.ts`, `AlertsPanel.tsx`, `frontend/src/lib/push.ts` for the web-push subscription flow.
- Ferry/maritime integration
- Terrain/weather overlays — the terrain half is built (2D hillshade, not weather), see §18. Weather half specced, see §21.
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

- **Frontend**: React, TypeScript, Vite, MapLibre GL JS, Tailwind CSS. Basemap: **OpenFreeMap vector styles** (`tiles.openfreemap.org` — free, no API key, no rate limit, still OSM data underneath, no vendor lock-in); originally a plain OSM raster tile source, swapped for a muted vector style since the raster default's saturated colors/heavy labeling competed with the aircraft markers for attention (see docs/Aircraft-type-visual-differentiation.md) — Positron first, later moved to **"Bright"** as the single default (keeps real color for water/parks/roads while staying calmer than raw OSM raster). A user-selectable picker across Bright/Positron/Liberty/Dark/Satellite, plus an independent terrain-relief overlay, is built — see §18. Aircraft icons: **custom SVG silhouettes per ADS-B/typecode class** (heavy/large/small/rotorcraft/glider/ultralight/uav), rotated by heading — chosen over tar1090's per-type icon set after checking those are inline SVG path data covered by the *same* GPLv2+ license as that whole repo (no separate permissive per-asset license), which would mean real copyleft exposure if copied into PugetScope's own source tree. Not worth the licensing entanglement for a portfolio project.
- **Backend**: Node.js, Fastify, WebSockets (`ws` or Fastify's websocket plugin)
- **Database**: PostgreSQL + PostGIS extension (aircraft history, users, region metadata)
- **Cache**: Redis (latest aircraft positions, session/rate-limit data)
- **Auth**: Hand-rolled sessions — `argon2` for password hashing, random 32-byte session tokens (`crypto.randomBytes`) stored in Redis with expiry, httpOnly/Secure/SameSite cookies; Postgres holds the user record. OAuth (Google/GitHub) via **Arctic** (minimal, framework-agnostic OAuth client — same author as the now-deprecated Lucia) for the handshake only; both local login and OAuth callbacks terminate in the same session-creation function. Decided against Passport.js (Express-shaped, needs an adapter for Fastify) and against a full auth framework like Auth.js (too framework-opinionated, less to explain in an interview).
- **Containerization**: Docker for every service from day one
- **Orchestration**: Kubernetes — local dev via **k3d** (chosen over kind/minikube: fastest iteration loop, built-in LoadBalancer + local registry, k3s is a real production-grade distro so the experience transfers); cloud via **self-managed K8s on EC2 via kubeadm** — no EKS, to avoid the control-plane cost and to own cluster administration end to end. Pin an explicit ingress controller (e.g. nginx-ingress) in k3d rather than relying on its default Traefik, so manifests stay portable to the EC2 cluster. TLS on the EC2 cluster via **cert-manager** + Let's Encrypt (ACME HTTP-01), installed the same way as ingress-nginx — vendor's pinned static manifest, not Helm.
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

**Managed vs. self-hosted Postgres/Redis — Redis decided and shipped, Postgres still open.** Phase 1 as built used RDS (Postgres+PostGIS) and ElastiCache (Redis) — managed services, ~$26/mo combined (db.t4g.micro + cache.t4g.micro). **Redis moved in-cluster** (as a K8s Deployment on the existing EC2 worker node, backed by the same `base/datastores/redis-deployment.yaml` manifest Phase 0's local k3d overlay already used, now with explicit `resources` requests/limits): ElastiCache only ever held ~6.6MB of latest-position/pub-sub data with no persistence requirement (rebuilds within one 30s ingestion poll), and the worker node had real memory headroom, so the managed service was buying isolation this workload didn't need. Verified live (117 keys under real traffic, zero consumer connection errors) before decommissioning ElastiCache via `terraform apply`, dropping ~$11.60/mo. **Postgres stays on RDS** — it holds real, non-rebuildable history (`positions`, `aircraft`, `fids_flights`, `zip_boundaries`, users/sessions), so the backup/PITR/failover tradeoff that justified moving Redis doesn't carry over the same way; self-hosting it would mean owning disk-failure recovery for data that can't just regenerate from the next poll. Not revisited since Redis shipped.

## 10. Open Questions

- Self-hosting Postgres (K8s pod + EBS PV on the EC2 worker, ~$20/mo cheaper) vs. staying on RDS — see §9. Redis went the self-hosted route; Postgres hasn't, because unlike Redis it holds real data that can't be rebuilt from the next poll cycle, so the calculus isn't just cost.

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
8. ~~Self-managed K8s on EC2 via kubeadm~~ — done: kubeadm-bootstrapped cluster (1 control-plane + 1 worker, Flannel CNI, baremetal/NodePort ingress-nginx) on the Phase 1 nodes, all via SSM (no SSH key exists on these instances by design). `k8s/` restructured to Kustomize (`base/` + `overlays/{local,ec2}`, with in-cluster Postgres/Redis pulled out into an opt-in `base/datastores` Component so `overlays/ec2` can use RDS/ElastiCache while `overlays/local` keeps k3d's in-cluster datastores — keeps the §9/§10 managed-vs-self-hosted question genuinely open). RDS schema bootstrapped via a one-off Job (Terraform can't run SQL); ECR image pulls need their own refreshed pull secret (self-managed kubelet has no built-in ECR credential provider, unlike EKS). See `k8s/README.md` "EC2 cluster" section for full details, including one thing surfaced during this pass: OpenSky Network appears to block AWS IP ranges — `ingestion` reached RDS/Redis fine but its OpenSky polls timed out, verified at the node level. **Since resolved** via a non-AWS forward proxy (`OPENSKY_PROXY_URL`, `ingestion/src/openskyClient.ts`) — live aircraft data now flows through this deployment; see `k8s/README.md`. Also: the EC2 Terraform user-data was missing `conntrack`/`ebtables`/`socat` (kubeadm preflight deps, fixed in `terraform/modules/ec2/templates/node-init.sh.tpl` for future nodes) — installed by hand on the two live nodes, and since the fixed template's `user_data` would otherwise differ from the live nodes' real (hand-patched) one, `user_data_replace_on_change = true` was pulling that dormant diff into *any* apply touching this resource and proposing replacement of both live nodes; `terraform/modules/ec2/main.tf` now has `lifecycle { ignore_changes = [user_data] }` so the fix is captured in the template for future nodes without threatening the running cluster. A real node rebuild (matching `user_data` for real) is deliberately deferred to the Phase 3 HA milestone.
9. ~~Domain + TLS cutover~~ — done: stable Elastic IP (`terraform/modules/ec2`) + Route 53 hosted zone (`terraform/modules/route53`), Hostinger nameservers delegated to it, kube-apiserver's NodePort range expanded to include 80/443 so ingress-nginx could bind the standard ports instead of a random high one, cert-manager + Let's Encrypt (staging issuer validated the ACME flow first, then production). Caught and fixed two real bugs this surfaced: RDS enforces SSL but the Node `pg` client wasn't negotiating it (added a `POSTGRES_SSL` toggle, `api`/`ingestion` `config.ts`), and mutable ECR tags (`ec2-latest`) weren't triggering a re-pull on redeploy since Kubernetes only defaults `imagePullPolicy: Always` for the literal tag `latest` (now set explicitly). Full signup/login flow verified end-to-end over the real domain, including the `Secure` session cookie (`api/src/auth/session.ts`) which silently doesn't work without real HTTPS — this was the reason TLS came before, not after, the domain cutover. Live at **https://pugetscope.com/**. See `k8s/README.md` "EC2 cluster" section.
10. Multi control-plane HA rebuild (deliberate later milestone, per §9).

First v2 feature (independent of the infra track above): **flight routing enrichment**, fully specced in §12.

## 12. Flight Routing Enrichment (v2 — partially built)

Goal: show, per aircraft, where it departed from, where it's going, and an estimated arrival time. This is the routing/schedule layer OpenSky's live `/states/all` feed lacks.

**Build status:**
- ✅ **FIDS match (tier 1, AeroDataBox)** — built (`fidsClient.ts`, `db/fidsFlights.ts`, `fidsRefreshWorker.ts`). Checked highest-priority in `attachRoutes`. Confirmed endpoint details directly from AeroDataBox's OpenAPI spec: `GET /flights/airports/icao/{icao}/{fromLocal}/{toLocal}`, TIER 2 pricing (2 units/call), RapidAPI ULTRA plan = 60,000 units/mo = 30,000 calls/mo. Covers all 5 regional airports (KSEA, KPAE, KBFI, KRNT, KTIW): KSEA refreshes every 5 min (~8.6k calls/mo, ~17.3k units), the other 4 every 10 min (~4.3k calls/mo each, ~34.6k units total) — combined ~51.8k units/mo, ~14% headroom under budget. A persisted `fids_refresh_state.last_fetched_at` per airport means a service restart never resets any airport's cadence or causes a fetch burst. Also delivers **real ETA** for arrivals (FIDS's `revisedTime` — an actual live estimate, not the haversine calc below), surfaced as `route.eta`. Verified: the exact `DAL889` case that opened this whole investigation (observed landing at SEA, previously cached by the now-removed adsbdb tier as `PDX→JFK`) resolves to `PDX→KSEA`, `confidence: "live"`, with a real ETA.
- ✅ **Own-track inference (tier 2, final fallback)** — built (`regionalAirports.ts`, `attachRoutes.ts`). A landing/departing aircraft near a regional airport gets a partial `"inferred"` route (the observed endpoint only) whenever there's no FIDS match. Verified live: 15/16 phase-matched aircraft in one poll went from no-route to a real inferred endpoint.
- ❌ **adsbdb crowd-sourced route cache** — removed. It was the original tier-3 fallback (the route a callsign *typically* flies, not necessarily this specific flight) and is exactly what produced the `DAL889` bug above; even with plausibility suppression catching *contradicted* cases, an uncontradicted-but-wrong cached route (e.g. a reused callsign) could still surface silently. Superseded by expanding FIDS to all 5 regional airports instead of trusting a stale crowd-sourced cache. `flight_routes` table and `adsbdbClient.ts`/`routeLookupWorker.ts` removed accordingly.
- ⬜ **Self-computed haversine ETA** (fallback for tier 2, when no FIDS match) — designed below, not yet built.

### ETA — computed ourselves, free

The route lookup gives the **destination airport's coordinates**; OpenSky already gives the aircraft's live position + ground speed. So ETA is derived locally:
`eta_seconds = haversine(current_pos, destination_coords) / ground_speed`, `eta_time = now + eta_seconds`. Guard against near-zero ground speed (on-ground/taxiing → no ETA). Recompute at **read time** (see below), not stored — so it refines automatically as the aircraft nears its destination, at zero API cost and never going stale. Label it clearly as an estimate in the UI: it ignores approach patterns, holding, and taxi time and assumes a direct constant-speed path.

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

### Routing accuracy upgrade (both tiers built, adsbdb tier removed)

**Problem the original build had.** adsbdb/hexdb return the route a callsign *typically* flies, not what the specific in-progress aircraft is doing. Observed live: `DAL889` descending into SEA (175 m, sinking, over Renton) but cached as PDX→JFK — plainly wrong for that airframe. Other free live-ADS-B APIs (airplanes.live, adsb.fi, adsb.lol, ADSB One) were checked and use the *same* crowd-sourced route DBs, so switching providers doesn't help. Plausibility suppression (dropping a cached route contradicted by direct observation) mitigated the *contradicted* cases, but an uncontradicted-but-wrong cached route (e.g. a reused callsign) could still surface silently — so the tier was removed outright rather than further patched, in favor of real schedule data from AeroDataBox across all 5 regional airports.

**Design: a confidence-tiered hybrid.** Resolve each aircraft's route through tiers, highest confidence first, and label the result's confidence in the UI:

1. **FIDS match — authoritative, "live" (✅ built, `ingestion/src/enrichment/fidsClient.ts` + `db/fidsFlights.ts` + `fidsRefreshWorker.ts`).** Pulls the live arrivals + departures board for each of the 5 regional airports and matches the aircraft's callsign against *today's actual* flights via **AeroDataBox** on RapidAPI (`GET /flights/airports/icao/{icao}/{fromLocal}/{toLocal}`, confirmed directly from their OpenAPI spec). `callSign` is returned on every flight and is a direct join key against OpenSky's callsign — no fuzzy matching needed. `movement.airport` already resolves to the *opposite-end* airport of that leg (destination for a departure, origin for an arrival), and `movement.revisedTime` is a real live actual/estimated time — surfaced as `route.eta` for arrivals.

   **Real cost math (this is TIER 2, not the always-free tier):** 2 units/call, RapidAPI ULTRA plan = 60,000 units/mo = **30,000 calls/mo**. KSEA refreshes every 5 min (~8.6k calls/mo, ~17.3k units); the other 4 fields (PAE/BFI/RNT/TIW), each far lower-traffic, refresh every 10 min (~4.3k calls/mo each, ~34.6k units total) — combined ~51.8k units/mo, ~14% headroom under the 60k budget. A 12h-window-per-call limit means each fetch spans roughly `now - 3h` to `now + 9h`, weighted toward upcoming/recently-active traffic. `fids_refresh_state.last_fetched_at` is persisted per airport so a service restart/redeploy never resets any airport's cadence or causes a fetch burst — the worker's own check loop runs every 5 min and refreshes whichever airports are due. Bonus: the same board data would unlock the deferred "airport departures/arrivals dashboard" feature (§2 v2 backlog) if built out further.

   Gated on `AERODATABOX_API_KEY` being set (an optional env var, unlike OpenSky's required credentials) — without it, `attachRoutes` just falls through to tier 2 (own-track inference) as before, logged once at startup. Verified: parsing/caching/matching logic checked end-to-end against a realistic mocked AeroDataBox response (a real key requires a RapidAPI signup, which only the account owner can do) — the exact `DAL889` case that motivated this whole upgrade (observed landing at SEA, adsbdb wrongly cached as `PDX→JFK`) now resolves to `PDX→KSEA`, `confidence: "live"`, with a real ETA.

2. **Own-track inference — high confidence for the in-region endpoint, final fallback (✅ built, `ingestion/src/enrichment/regionalAirports.ts` + `attachRoutes.ts`).** We are literally watching the aircraft: one descending toward a known regional airport (altitude falling, vertical rate negative, within ~15km, near-ground altitude) lets us assert its **destination** directly; one climbing out asserts its **origin**. No external source needed. Only the *far* endpoint (where an arrival originally came from / where a departure ultimately terminates) is left unknown (`null`) — implemented as a partial route (one endpoint populated, the other `null`), rather than inventing a value for the unobserved side. Used whenever there's no FIDS match (e.g. through-traffic overflying the region without landing/departing locally). Verified live against real traffic: 15 of 16 aircraft matching a landing/departing phase in one poll went from no-route to a genuine inferred endpoint (e.g. `N9655B` departing KPAE → `KPAE→?`).

**Confidence field (✅ built).** `route.confidence` (`"live" | "inferred"`) flows from `ingestion` through the Redis blob to the API/WebSocket and is rendered as a confidence-keyed disclaimer in the frontend detail panel, with `route.eta` (only present on a `"live"` arrival match) rendered as a countdown when available. This is the honest, portfolio-worthy framing: multi-source enrichment with explicit, surfaced confidence rather than a single unreliable lookup presented as fact.

**Remaining gap:** the haversine self-computed ETA (above) is still unbuilt, so `"inferred"` routes have no ETA at all yet — only `"live"` FIDS matches do.

## 13. Noise/Overflight Analytics by Neighborhood (v2 — partially built)

Goal: answer "what flew over this specific zip code, how low, how often, and when" — a materially better tool for the actual question Puget Sound residents have than a generic flight tracker offers, and distinctly tied to a real, long-running local issue (SeaTac noise impact on Burien/Des Moines/SeaTac/Tukwila and Seattle's Beacon Hill/Georgetown/South Park). See conversation history for the fuller civic-context rationale. Deliberately **zip-code (ZCTA) granularity**, not hand-drawn neighborhood polygons — covers both Seattle proper and the surrounding cities under SEA's flight paths from one public, keyless dataset, rather than merging two boundary sources.

**Build status:**
- ✅ **Zip boundary reference data** — built (`ingestion/src/enrichment/loadZipBoundaries.ts`, run via `npm run load-zips`). One-time (re-runnable) load from **Census TIGERweb** (`Census2020/PUMA_TAD_TAZ_UGA_ZCTA` ArcGIS REST service, layer 2 = "ZIP Code Tabulation Areas") — free, no API key, and supports a server-side envelope filter so this only pulls ZCTAs intersecting the project bbox (§3) instead of downloading the full national dataset. `zip_boundaries(zcta5 PK, boundary GEOGRAPHY(MULTIPOLYGON, 4326))`, GiST-indexed. Verified live: 217 ZCTAs loaded against production, confirmed covering all the noise-relevant zips (98108, 98146, 98158, 98168, 98188, 98198).
- ✅ **Overflight aggregation queries** — built (`api/src/routes/analytics.ts`), not yet deployed to the running `api` service. A spatial join (`ST_Intersects`) between `positions` and a zip's `boundary`, using the existing GiST index on `positions.position` — no new ingestion-side work, since `positions` has been accumulating full (lat/lon/altitude/heading/timestamp) history since ingestion went live regardless of this feature. Two endpoints:
  - `GET /analytics/overflights/summary?zip=&days=` — hour-of-day histogram (Pacific time). "Overflights" = distinct `(icao24, calendar day)` pairs per hour bucket, summed over the lookback window, to avoid the ~30s poll cadence inflating the count with dozens of rows per actual pass. Returns count + avg/min altitude per hour.
  - `GET /analytics/overflights/events?zip=&from=&to=` — for a narrow (≤24h) window, one row per aircraft (its lowest-altitude point in the window, i.e. closest approach), joined against `aircraft` for registration/manufacturer/model/operator. This is the "what was that loud plane at 6:47pm" lookup.
- ✅ **Verified against real production data**, not just mocked: spatial join results line up with known local geography — 98188 (SeaTac, adjacent to the runways) shows 100–330 overflights/hour at 46–1200m; 98108 (Beacon Hill, directly under SEA's north-flow corridor) is the busiest zip observed, with altitudes dipping slightly negative during several hours (WGS84 ellipsoidal height near sea level in a region where the geoid dips below the ellipsoid — expected near-runway-threshold behavior, not a bug); 98146 (Burien) shows far fewer intersecting positions, mostly cruise-altitude traffic, under the runway configuration active during the sample window.
- ✅ **Shipped to production** — `analyticsRoutes` registered in `api/src/index.ts` alongside the other route modules.
- ✅ **Frontend** — `NeighborhoodAnalyticsPanel.tsx` (zip picker across the 6 confirmed-relevant zips + day-range selector + hour-of-day chart, `EVENTS_WINDOW_HOURS`-wide closest-approach event list), wired into the `IconRail` in `App.tsx`. Deep link at `/neighborhood/:zip` (`useUrlRoute.ts`), same `initialZip`/`onZipChange` prop pair pattern later reused by `AirportBoardPanel` (§14).

## 14. Airport Departures/Arrivals Board (v2 — built)

Status: built per the spec below. Depended on nothing new — this is the FIDS board data §12 already fetches, exposed as its own view instead of staying an internal join key.

**Build status:**
- ✅ **API route** — `api/src/routes/airports.ts`, registered in `api/src/index.ts`. `GET /airports/:icao/board?direction=departure|arrival` reads `fids_flights` directly (no new ingestion-side work), ordered by `COALESCE(revised_time, scheduled_time) ASC`. Same `{ max: 20, timeWindow: "1 minute" }` rate-limit override as the other analytics routes.
- ✅ **Frontend** — `AirportBoardPanel.tsx` (same `Panel`/`PanelHeader` shell as `TrafficVolumePanel`): airport picker (5 regional fields) + departures/arrivals toggle, polled every 60s (a board reflects "right now", unlike the traffic/noise panels' slower aggregates). Wired into the `IconRail` in `App.tsx`.
- ✅ **Deep link** (`/airport/:icao` in `useUrlRoute.ts`) — built, matching the existing `/aircraft/:icao24` and `/neighborhood/:zip` cases: a third `UrlRoute` variant, `AirportBoardPanel` takes the same `initial*`/`on*Change` prop pair `NeighborhoodAnalyticsPanel` already established (`initialAirport`/`onAirportChange`), and `App.tsx`'s per-panel URL logic (previously a two-way `noise`-or-home ternary in both `closeAircraftDetail` and `toggleRailPanel`) was pulled into one `pathForRailPanel()` helper now that there are two non-home cases to keep in sync rather than duplicating a three-way branch at both call sites.

Goal: a live departures/arrivals list per regional airport, the standard "airport board" view every spotter/tracker site has — currently the closest thing this app has is `attachRoutes.ts` silently consuming the same data to label individual aircraft.

**What already exists.** `fids_flights` (`db/init/001_schema.sql`) is kept current by `ingestion/src/enrichment/fidsRefreshWorker.ts`: KSEA refreshed every 5 min, the other 4 regional fields every 10 min, each fetch spanning roughly `now - 3h` to `now + 9h`. `ingestion/src/db/fidsFlights.ts`'s `replaceBoard()` does a full `DELETE` + re-`INSERT` per airport on every refresh (not a merge) specifically so the table always exactly reflects the current AeroDataBox window — a flight that fell out of the 12h window disappears from the table on the next refresh, nothing needs to be swept separately. That means the table is *already* board-shaped: no extra staleness filtering needed at read time, just a `SELECT ... ORDER BY`.

**New API route** — `api/src/routes/airports.ts` (new file, registered in `api/src/index.ts` alongside the others):

```
GET /airports/:icao/board?direction=departure|arrival
```

- `:icao` validated against a local `REGIONAL_AIRPORTS` list (icao/iata/name only) — mirrors the const already duplicated in `traffic.ts` rather than importing from `ingestion`, per this repo's no-shared-package convention (`docs/rollup-tables.md`).
- `direction` optional; omitted returns both. Response:
  ```json
  {
    "airport": "KSEA",
    "departures": [{ "callSign", "flightNumber", "airlineName", "status", "other": {"icao","iata","name"}, "scheduledTime", "revisedTime" }],
    "arrivals": [...]
  }
  ```
- Ordered by `COALESCE(revised_time, scheduled_time) ASC` — soonest first, the natural "board" order. No separate handling for already-departed/landed flights: they stay in the table until they age out of AeroDataBox's window, and the existing `status` field (AeroDataBox-provided: scheduled/departed/landed/delayed/etc.) is what the frontend uses to visually distinguish them, rather than the API filtering rows out.
- `AERODATABOX_API_KEY` unset (FIDS disabled, per §12) → `fids_flights` stays empty → the route returns empty arrays, not an error. Same graceful-degradation posture as routing's tier-2 fallback.
- Rate limit: same `{ max: 20, timeWindow: "1 minute" }` override as the other read-heavy analytics routes.

**Frontend.** A new rail panel (`AirportBoardPanel.tsx`, same `Panel`/`PanelHeader` shell as `TrafficVolumePanel`): airport picker (5 regional fields) + a departures/arrivals toggle, list rows showing time, other-end airport, status. Natural follow-on once this exists: extend the deep-link scheme (§6 engagement work — `useUrlRoute.ts`) with `/airport/:icao` so a specific field's board is shareable, the same way `/aircraft/:icao24` and `/neighborhood/:zip` already are — not required for v1 of this feature, just a cheap addition once the route table has a third case.

## 15. Runway/Flow-Direction Indicator (v2 — built)

Status: built per the spec below.

**Build status:**
- ✅ **Runway reference data** — added to `REGIONAL_AIRPORTS` (`ingestion/src/enrichment/regionalAirports.ts`): each field's primary-runway heading pair, as TRUE headings (not magnetic — matched directly against ADS-B `trueTrack`; the 180° separation between ends means the ~15-16°E local magnetic variation can't flip a classification). Verified per-field against AirNav's FAA 5010 data rather than assumed: KSEA/KPAE 180°/0°, KBFI 150°/330° (runways 14/32, not the initially-guessed 13/31), KRNT 174°/354°, KTIW 187°/7°.
- ✅ **Inference + rolling vote** — built (`ingestion/src/enrichment/flowDirection.ts`). Reuses `inferFlightPhase()`'s existing landing detection, buckets each landing aircraft's `trueTrack` against whichever runway end it's circularly closer to, and keeps an in-memory 18-minute rolling buffer per field (not persisted — same class of intentionally-ephemeral state as the frontend's flight trails) so a momentary gap in approach traffic doesn't flap the reading to "unknown". Majority vote over the window yields `confidence: "high"` (≥3 samples, ≥65% agreement) or `"low"`; an empty window is `"unknown"`. A `flow: "north" | "south"` label is derived from the winning heading itself (closer to true 0° or true 180°) rather than hand-mapped per airport, since all 5 regional fields happen to be roughly north-south aligned.
- ✅ **Redis + API** — written per poll to `airport:flow:{icao}` (10 min TTL, self-clearing if ingestion stops), read by the new `GET /airports/:icao/flow` (`api/src/routes/airports.ts`) — a plain Redis GET, same shape as `/aircraft` reading `aircraft:latest:*`. Deliberately not pushed through the WebSocket `/live` feed, per the original design (this changes on the order of hours, not seconds); a missing key (never-populated or TTL-lapsed) returns a graceful `confidence: "unknown"` response rather than an error.
- ✅ **Frontend** — `FlowBadge.tsx`: an ambient, no-click-required single-line badge next to the existing live/connected status pill (bottom-left), e.g. "SEA: South Flow (rwy 16)". Each field's reading is (re-)fetched every 60s; the badge rotates which field it's currently showing every 10s, cycling only through fields with a populated rolling window (`confidence` other than `"unknown"`) rather than all 5 at once — an earlier all-5-stacked-at-once version made the badge taller than the single-line status pill beside it and the two didn't align cleanly (`items-center` vertically centered them against each other rather than sharing a bottom edge, the same trap already hit once before with the rail dock). Hides itself entirely if no field currently has a reading.
- Departures-only runway-half inference (which specific parallel strip, e.g. 16L vs 16C vs 16R) remains out of scope, as originally scoped — only the numbered runway/flow direction is inferred, not the specific parallel runway.

Original spec (for reference — matches what was built):

Goal: surface which runway configuration a regional field — SEA above all — is currently using, e.g. "North Flow (landing 34L)" vs. "South Flow (landing 16R)". Real aviation terminology (what ATIS/spotters actually say), inferred purely from geometry already being observed — no new data source, and it feeds both general spotter interest and the noise-analytics angle (§13): which zips are getting overflown depends heavily on which flow direction is active.

**Inference approach.** `ingestion/src/enrichment/regionalAirports.ts`'s `inferFlightPhase()` already detects, per poll, which aircraft are geometrically on approach to (or departing) a regional field — proximity + altitude-vs-distance envelope + vertical rate. It currently discards heading once phase is known; flow-direction inference is the same detection, plus classifying the aircraft's `trueTrack` against the field's actual runway orientation.

This needs one new piece of static reference data: each regional field's runway heading pair. Runway numbers *are* headings (rounded to the nearest 10°, e.g. "runway 34" ≈ 340° magnetic), so this is real, look-up-able data, not something to infer — SEA's parallel runways are the well-known 16/34 pair (~160°/340°); the other 4 fields' orientations need pulling from their FAA airport diagrams before this is built, not assumed. Proposed shape, extending `REGIONAL_AIRPORTS`:

```ts
{ icao: "KSEA", ..., runwayHeadings: [162, 342] as const } // verify exact headings per field before building
```

Per poll, for each field: take every aircraft `inferFlightPhase` currently calls `"landing"` there, bucket its `trueTrack` against whichever of the field's two headings it's circularly closer to, and majority-vote across however many are landing in that poll. Arrivals only for v1 (departures follow the same flow but reasoning about which runway-half a departure used adds ambiguity not worth it for a first pass) — noted as a possible v1.1 refinement, not required.

**Why a rolling window, not just the instantaneous poll.** A single ~30s poll can easily have zero aircraft on approach to a given field at that exact moment, especially the smaller GA fields — using only the current poll would flap between a real reading and "unknown" every time there's a gap. Keep a short in-memory rolling buffer per field in `ingestion` (last ~15–20 min of landing-phase heading observations), and compute the majority vote over that window instead of the single latest poll. In-memory only, not persisted — a service restart just means a brief "unknown" until fresh samples accumulate, the same class of intentionally-ephemeral state the frontend's own flight trails already are (`AircraftMap.tsx`'s `trailsRef`).

**Where the result lives.** Written to Redis per poll — `airport:flow:{icao}` → `{ runway, headingDeg, confidence: "high"|"low"|"unknown", sampleSize, asOf }`, short TTL (e.g. 10 min) so a stale reading self-clears if ingestion stops. New API route `GET /airports/:icao/flow` reads that key straight from Redis (mirrors `aircraft.ts`'s `/aircraft` route reading `aircraft:latest:*`) — deliberately *not* pushed through the WebSocket `/live` feed: flow direction changes on the order of hours, not seconds, so poll-on-demand (fetch when a panel/badge is visible, refresh every minute or so) fits better than adding a push path for something this slow-moving.

**Frontend.** Lowest-friction option: a small glanceable badge near the existing live/connected status pill (bottom-left) — "SEA: North Flow (rwy 34)" — no click required, matching the "ambient, no interaction needed" framing that fits a fact like this. A rail panel showing all 5 fields at once is a natural secondary option if a single SEA-only badge feels too narrow once built.

## 16. Historical Playback/Replay (v2 — built)

Status: built per the spec below. Per §2: "a query/UI problem against data already collected, not a new integration" — `positions` has been accumulating full history since ingestion went live, so this ended up being new `api` routes + frontend UI only, nothing touched `ingestion` or the live WebSocket feed.

**Build status:**
- ✅ **`GET /replay/bounds` / `GET /replay/frame`** — built as specced (`api/src/routes/replay.ts`), `windowSeconds` capped server-side at `MAX_WINDOW_SECONDS = 180`. `/replay/frame` carries its own rate-limit override (`{ max: 300, timeWindow: "1 minute" }`, above the platform default) since active playback ticks it once/sec — a tight cap was observed rate-limiting ordinary playback, not just abuse.
- ✅ **Frontend** — a "Replay" rail toggle swaps the map's data source from `useAircraftFeed()` to `useReplayFeed()`/`useReplayPlayback()` (`App.tsx`), with `ReplayScrubber.tsx` (slider + play/pause + speed) shown at the bottom of the screen while active, matching the original mode-toggle design — `AircraftMap.tsx` needed no changes, since it only ever cared about receiving an `AircraftByIcao`-shaped prop.
- **The typecode/category/route gap is partially closed, not fully.** The original spec below assumed a replayed aircraft would have no `typecode` at all. As built, `/replay/frame` left-joins `positions.icao24` against the static `aircraft` reference table (`typecode` is batch-loaded reference data, not per-position enrichment, so joining it costs nothing) — a previously-enriched aircraft renders with a real typecode-classified marker on replay, not always the "unknown type" fallback. `category` and `route`/ETA remain genuinely unavailable (both are Redis-blob-only, never persisted per position row) — a replayed aircraft still has no route panel content. Accepted limitation, as originally scoped.

Goal: scrub back through recent history and watch the region's traffic replay — "what flew over 2 hours ago."

**The constraint this has to respect.** This project has already hit, and documented, exactly the failure mode a naive version of this feature would repeat: `docs/Region-wide-traffic-totals.md` and `docs/rollup-tables.md` cover a real incident where an *unselective* query against `positions` (a wide date range aggregated with no other predicate — up to 90 days, effectively the whole table) blew Postgres's 30s `statement_timeout` even with the right indexes in place, because an index only helps when the predicate excludes most of the table — aggregating almost all of it is a cost no index removes. Replay is different in kind, not just degree: it never aggregates a wide window, it fetches raw rows for one *narrow* time slice at a time (a single scrubber frame, seconds to low minutes wide) — inherently selective by construction, as long as the API is designed so a request can never ask for more than that. The existing `positions_icao24_recorded_at_idx` and `positions_recorded_at_idx` (added for exactly this table, see `docs/postgres-btree-indexing.md`) already cover this access pattern; no new index should be needed.

**Two new `api` routes** (new file, e.g. `api/src/routes/replay.ts`):

```
GET /replay/bounds
```
`{ earliest: ISO, latest: ISO }` — `MIN(recorded_at)` / `MAX(recorded_at)` over all of `positions`, so the frontend scrubber knows the full available range. Safe despite touching "all of positions" in the query text: `MIN`/`MAX` over a B-tree-indexed column is an index-only scan reading one end of the tree, not a table scan — a different cost profile from the `COUNT(DISTINCT ...)` that caused the earlier incident, worth calling out explicitly since it looks superficially similar.

```
GET /replay/frame?at=<ISO>&windowSeconds=90
```
Returns each aircraft's most recent known position within `[at - windowSeconds, at]` — one row per `icao24`, via `DISTINCT ON (icao24) ... WHERE recorded_at BETWEEN $1 AND $2 ORDER BY icao24, recorded_at DESC`, the same "narrow, sargable range on the raw column" shape `trafficRollup.ts` already established works well against this table. `windowSeconds` small and capped server-side (e.g. max a few minutes) — the caller picks *when*, not *how much*, so a request can't accidentally turn into a wide scan. No new index needed per above.

Original spec's gap analysis (for reference — see "typecode/category/route gap" bullet above for what actually shipped): `positions` only stores `icao24, callsign, position, altitude, ground_speed, heading, vertical_speed, recorded_at` — no `typecode`, `category`, or `route`. Those are enrichment fields attached only to the *live* Redis blob (`ingestion/src/enrichment/attachAircraftType.ts`, `attachRoutes.ts`), never persisted per position row. A replayed frame can still join `positions.icao24` against the static `aircraft` reference table for registration/manufacturer/model/operator/typecode (that part *is* stored and joinable), but a replayed aircraft has no `category` and no route/ETA — no route panel content on replay. Accepted limitation, not solved.

**Frontend.** Rather than a small side panel like the other rail features, replay changes what the *map itself* shows, so it's better framed as a mode toggle for the whole app: a "Replay" toggle (rail item) that swaps the map's data source from the live `useAircraftFeed()` hook to a new `useReplayFeed()` hook (polls `/replay/frame` on a timer as the scrubber advances, converts each frame into the same `AircraftByIcao` shape `useAircraftFeed` already produces) and surfaces a scrubber bar (slider + play/pause + speed: 1x/5x/20x) at the bottom of the screen while active. `AircraftMap.tsx` needs no changes to render replayed traffic — it already only cares about receiving an `AircraftByIcao`-shaped `aircraft` prop, not where it came from; `App.tsx` just decides which hook currently feeds it.

## 17. Daily Digest Enrichment (v2 — partially built)

Status: 17.1 and 17.2 built (below); 17.3–17.5 still spec-only. Extends the existing digest (`ingestion/src/generateDigest.ts`, `digests` table, built per the commit history) rather than replacing it — `DigestStats` originally was just `{date, totalFlights, byAirport}` sourced from `traffic_daily_counts`, enough for a flat "N flights" blurb but leaving every other table in the schema (`aircraft`, `fids_flights`, `zip_boundaries`, `spottings`) untouched. This section specs additional real, queryable facts to fold into `DigestStats` so the nightly LLM call has more to genuinely observe.

**Ground rule carried over unchanged from the existing prompt:** `generateContent()`'s instruction — "plain factual prose describing the day's air traffic based only on these numbers, no speculation" — stays the contract as `DigestStats` grows. Every new field below is a real aggregate query result, computed in `loadStats()` before the LLM is ever called, never left for the model to infer. The output JSON schema (`headline`/`body`/`metaDescription`) doesn't need to change; only the input stats and the prompt's fact list grow.

### 17.1 Trend comparisons (cheap — `traffic_daily_counts` / `traffic_hourly_counts` only) — ✅ built

No new tables or indexes — both rollup tables already exist and are maintained incrementally by `ingestion/src/db/trafficRollup.ts`.

- Same-day-last-week delta: `loadVsLastWeek()` in `generateDigest.ts` — `SELECT flights FROM traffic_daily_counts WHERE scope='REGION' AND date = ($1::date - interval '7 days')::date`, compared against the current day's already-loaded `region` count via `formatWeekComparison()`.
- Busiest hour of the day: `loadBusiestHour()` — `SELECT hour FROM traffic_hourly_counts WHERE scope='REGION' AND date=$1 ORDER BY flights DESC LIMIT 1`, formatted via `formatHourRange()`.
- `DigestStats` fields: `vsLastWeek: number | null` (null if no row 7 days back yet — same "don't fabricate a comparison with no baseline" posture `loadStats()` already applies to the missing-REGION-row case), `busiestHour: number | null`. Both are omitted from the LLM prompt entirely when null, rather than mentioned as zero/unknown.

### 17.2 Notable aircraft (`aircraft` table) — ✅ built

Goal: surface a rare type/operator/registration seen that day, not just a count.

- **Rarity definition (resolved):** first-ever sighting, via `aircraft.first_seen` — set once on insert and never updated (`insertPositions`'s `ON CONFLICT ... DO UPDATE SET last_seen = now()` never touches `first_seen`), so it's a genuine "never seen before this station" signal, not the positions-join rarity baseline originally sketched below.
- `loadNotableAircraft()` — `SELECT icao24, registration, manufacturer, model, typecode, operator FROM aircraft WHERE (first_seen AT TIME ZONE 'America/Los_Angeles')::date = $1::date AND typecode IS NOT NULL ORDER BY icao24 LIMIT 5` — cheaper than the original plan since it skips the `positions` join entirely; capped at `NOTABLE_AIRCRAFT_LIMIT` and restricted to rows with a `typecode` so the digest always has something concrete to describe.
- `DigestStats` field: `notableAircraft: NotableAircraft[]` (empty array, not null, when none found that day — the prompt only adds the "first-ever tracked today" line when the array is non-empty).
- **Bug found and fixed: this never actually surfaced anything in practice.** The `typecode IS NOT NULL` filter requires an aircraft to already be enriched by the time its `first_seen`-matching digest runs — but enrichment (`runEnrichment()`/`fillMissingAircraft()`, `ingestion/src/enrich.ts`) was manual-only (`npm run enrich`), with no scheduled job anywhere. Since the digest only ever checks a given date once, a newly-first-seen aircraft's typecode had to land within that same narrow window (`first_seen` → the next day's 10:00 UTC digest run) or it would never qualify on any future digest — and nothing was driving enrichment on that cadence, so in practice it essentially never happened. Fixed by adding a scheduled `aircraft-enrich` CronJob (`k8s/base/aircraft-enrich-cronjob.yaml`, `0 9 * * *`, an hour ahead of `digest-generate`'s `0 10 * * *`) that runs the same `dist/enrich.js` daily. Idempotent and safe to run this often: `runEnrichment()`'s `UPDATE` is unconditional (not `COALESCE`), so it's just a refresh from the source CSV each time.

### 17.3 Airline/route highlights (`fids_flights`) — blocked on a real gap

Goal: "busiest airline," "longest delay," or "notable diversion" for the day, from AeroDataBox data already being fetched.

**The gap:** `fids_flights` is not historical. `ingestion/src/db/fidsFlights.ts`'s `replaceBoard()` does a full `DELETE` + re-`INSERT` per airport on every refresh, by design (§14) — the table is deliberately *only* ever the current ~3h-ago-to-9h-ahead window, so a flight that's already flown gets purged from the table well before the digest job runs at 10:00 UTC the next day. There is currently no persisted record of what `fids_flights` looked like for a given past day, so `generateDigest.ts` has nothing to query for "yesterday." Building this needs a new small rollup step — e.g. `fidsRefreshWorker.ts` upserting daily airline/status counts into a new table *before* `replaceBoard()`'s delete, mirroring how `trafficRollup.ts` incrementally maintains `traffic_daily_counts` instead of aggregating raw history after the fact. Not attempted here — a real gap to state plainly (matching how §12 and §16 each call out their own), not a silent limitation.

### 17.4 Neighborhood/overflight angle (`zip_boundaries` + `positions`)

Goal: "most overflown neighborhood" — ties the digest to the same civic angle as §13.

- `SELECT z.zcta5, COUNT(*) FROM positions p JOIN zip_boundaries z ON ST_Intersects(p.position, z.boundary) WHERE p.recorded_at >= $1 AND p.recorded_at < $1 + interval '1 day' GROUP BY z.zcta5 ORDER BY count DESC LIMIT 1` — same GiST index (`zip_boundaries_boundary_gist_idx`) §13's `analytics.ts` routes already use, and the same narrow-single-day range as §17.2 above, so no new timeout risk.
- New `DigestStats` field: `topZip: { zcta5: string; count: number } | null`.

### 17.5 Community angle (`spottings`) — low priority, usage-gated

- `SELECT COUNT(*) FROM spottings WHERE spotted_at >= $1 AND spotted_at < $1 + interval '1 day'` — trivial query, but the feature is new and likely low-volume, so most days this would read "0 sightings" for a long while. Suggest only including this fact in the prompt when the count is > 0 (same "don't publish a fact that's just noise" posture as the REGION-row check), rather than teaching the LLM to write around a near-always-zero number.

### Suggested build order

**17.1 and 17.2 are built.** Remaining, cheapest first: **17.4 (neighborhood)** needs no new tables and reuses an existing index — a straightforward addition to `loadStats()`, same pattern as 17.1/17.2. **17.3 (airline/delay highlights)** is blocked on a real gap — a new persisted FIDS rollup table — and shouldn't be scoped as "just another query" until that's built. **17.5 (community)** is trivial but not worth adding until `spottings` has real usage.

## 18. Selectable Basemap Styles + Terrain Relief (v2 — built)

Status: built per the design below.

Goal: let a user pick which basemap the live map renders against, instead of the single hardcoded default everyone gets today. `AircraftMap.tsx`'s basemap comment already documents that Positron, Liberty, and an unlisted "dark" OpenFreeMap style were evaluated and rejected as *the one default* — this makes all of them selectable rather than picking one winner for everyone, and adds a satellite style and a terrain-relief overlay that didn't exist as options at all before.

**Two independent controls, not N mutually-exclusive options.** A bare elevation raster (hillshade) has no roads, water, or labels — it isn't useful as a *base* map on its own, only as an overlay. So:
1. **Base style** (mutually exclusive): Bright (current default) · Positron · Liberty · Dark · Satellite.
2. **Terrain relief** (independent boolean), layered on top of whichever base is active — disabled in the UI when Satellite is selected, since real aerial photography already shows actual terrain shading/shadows and layering the synthetic hillshade on top would just look muddy/redundant.

**Style sources (all free, no API key, verified live):**
- Bright/Positron/Liberty/Dark: full OpenFreeMap vector style documents, `https://tiles.openfreemap.org/styles/{bright,positron,liberty,dark}` — swappable via `map.setStyle(url)`. "dark" isn't advertised on OpenFreeMap's own homepage (which lists only 3 styles) but is genuinely live at that URL.
- Satellite: Esri World Imagery raster XYZ tiles (`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}` — note the `{z}/{y}/{x}` order, not the usual `{z}/{x}/{y}`), CORS already open, sub-meter resolution over US metros including Seattle. The standard free/keyless satellite basemap almost every open-source map project uses. One honest caveat, same spirit as the option this replaced: Esri's terms position this free endpoint for general/evaluation use rather than unlimited high-traffic commercial production — accepted as reasonable for a low-traffic portfolio project, not a hard blocker. Not a style-JSON URL, so it's a minimal inline MapLibre style object built client-side (`version: 8`, one `raster` source carrying the required Esri attribution string, one `raster` layer, no `sprite`/`glyphs`). MapLibre's default `AttributionControl` (already active — the app never sets `attributionControl: false`) rebuilds its displayed text from every active source's `attribution` field automatically, so this alone satisfies the attribution requirement.
  - **Originally shipped as "Topographic" (OpenTopoMap)**, replaced by Satellite after real usage surfaced a genuine problem: OpenTopoMap's busy contour-line/vegetation coloring made small aircraft markers hard to pick out against the basemap. Satellite's more photographic look was chosen as the fix, paired with a marker-outline change (below) since satellite imagery has its own wide color range (dark forest, bright pavement, water, rooftops) that could just as easily swallow marker contrast in a different way — the basemap swap alone wasn't assumed to be sufficient.
- Terrain relief: AWS's public `elevation-tiles-prod` S3 bucket, Terrarium-encoded DEM tiles (`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`) — the de facto free standard for MapLibre's `raster-dem` source type; `encoding: "terrarium"` is a built-in MapLibre decode, nothing custom to compute. Rendered as a `hillshade` layer — not a `raster` layer with opacity, hillshade has no opacity paint property — subtlety instead comes from a low `hillshade-exaggeration` (e.g. `0.25`) and muted shadow/highlight colors rather than the stark black/white defaults. Inserted with an explicit `beforeId` (the style's first `symbol` layer) so it sits above land/water fills but below roads/labels; `addLayer()` with no third argument stacks on top of everything, which would bury roads/labels under the relief texture.

**Aircraft marker outline, added alongside the satellite swap.** `markerSvgMarkup()` (`AircraftMap.tsx`) now sets `stroke="white"` / `stroke-width="1.5"` / `paint-order="stroke"` on the marker SVG root (the child `<path>` elements set no fill/stroke of their own, so both inherit) — a clean white halo around the aircraft silhouette that reads against any basemap color, not just satellite. `paint-order="stroke"` draws the stroke first so the fill covers its inner half, rather than a stroke that bleeds outward and blurs the silhouette. This is a genuinely more robust fix than the basemap swap alone: satellite imagery's color range is wide enough that no single marker color reliably contrasts with everything underneath it.

**The mechanical constraint this has to respect: `setStyle()` wipes runtime layers.** `AircraftMap.tsx` already adds one runtime layer today — the selected aircraft's flight-trail line (`TRAIL_SOURCE_ID`), added via `addSource`/`addLayer` inside the map's `load` handler. `maplibregl.Marker` DOM elements (aircraft icons, the pending-pin marker) are independent of style/layers and survive `setStyle()` automatically; sources and layers do not. Verified directly against the installed `maplibre-gl` source (not docs/assumption): switching styles takes MapLibre's diffed-update path (`Style.setState()`), which diffs against the *current* style — including any runtime-added sources/layers — and applies the resulting add/remove operations, which is what wipes the trail line (and, once built, the hillshade layer) on every base-style switch. That diff-apply explicitly fires a `style.load` event afterward — **the same event that already fires once after the map's very first style load**, not a separate switch-only event. So there is exactly one place to re-add runtime layers: a single `map.on("style.load", () => addCustomLayers(map, {...}))` handler, replacing today's `load`-handler-only logic rather than living alongside it (registering both would double-add on first mount, since `style.load` fires before `load` even on initial creation). Rapid repeated style switches are already safe at the MapLibre level — each `setStyle()` call aborts any in-flight previous style fetch before starting the new one. Accepted, visible side effect: the trail line briefly renders empty immediately after a base-style switch, until the next aircraft-feed tick calls `setData()` on the freshly-recreated source — the in-memory trail history (`trailsRef`) itself isn't cleared, only the GeoJSON source object is.

**Persistence — anonymous-first, unlike the account-only `mapView` preference (§7, `user_preferences`).** Deliberately different from the saved-camera-view feature (`GET`/`PUT /preferences/map-view`, hard 401 if logged out): basemap choice is scoped to work with zero login, the same "anonymous by default, account adds sync" posture the alerts feature (`alert_watches`/`push_subscriptions.user_id`) established.
- Anonymous: written to `localStorage` (`pugetscope_map_style`, `{baseStyle, terrain}` JSON) on every change. Read synchronously *before* the `maplibregl.Map` is constructed, so the resolved style is the constructor's initial `style:` value directly — no flash-of-default-then-switch for a returning visitor.
- Logged in: same `localStorage` write on every change, plus a write-through to a new `user_preferences` row (`key='mapStyle'`, same table and route file as `mapView`) for cross-device sync. On login — both initial page load and an interactive login within an already-open session — the account's server value is fetched and **overrides** whatever's currently showing, including a same-session local change made moments earlier.
- That override-on-login is a real, deliberate tradeoff worth stating plainly: it's more disruptive here than for `mapView` (a camera `jumpTo` is unobtrusive mid-session; replacing the entire basemap is more noticeable), accepted because cross-device sync is the actual point of linking this to an account at all.
- No auto-seed (a local-only preference isn't pushed to the server just because someone logs in) and no logout-revert (whatever's currently rendered stays rendered) — both match `mapView`'s existing precedent.

**Out of scope.** Full 3D terrain relief (`map.setTerrain()`, camera pitch/tilt, elevation extrusion) — a materially different interaction model, and the existing DOM-based aircraft markers rendered over a tilted/extruded surface is untested in this app, worth its own investigation rather than folding into a basemap-picker feature. "Terrain" here means 2D hillshade only.

## 19. Aircraft/Airline Mix Stats (v2 — spec only)

Goal: leaderboard-flavored stats — busiest operator this week, rarest type spotted — building on the aircraft reference-data enrichment already loaded via the OpenSky Aircraft Database batch job (§7: registration/manufacturer/model/operator/typecode) rather than any new data source.

**The timeout trap this has to avoid.** "Busiest operator this week" needs `COUNT(DISTINCT icao24)` per operator over a 7-day window — the same *shape* of query (wide aggregate over `positions`) that caused the real incident documented in `docs/Region-wide-traffic-totals.md`/`docs/rollup-tables.md`. Rather than a live aggregate, this should follow the precedent already set there: a small incremental rollup table (e.g. `operator_daily_counts(operator, date, distinct_aircraft)`), maintained the same way `trafficRollup.ts` maintains `traffic_daily_counts` — updated per ingestion poll, not computed after the fact from raw history.

**"Rarest type spotted" — two distinct notions, pick one to avoid ambiguity:**
- *All-time rarity*: typecodes with the fewest distinct `icao24`s ever observed (`aircraft` table, all-time — no time window, no rollup needed, a typecode needs enough historical baseline for "rare" to mean anything).
- *Today's rarity*: reuses the digest's existing `loadNotableAircraft()` definition (§17.2) — `first_seen`-today, never-seen-before-at-this-station. Cheaper (already-written query), but a different claim ("new to us" vs. "genuinely uncommon").

Recommend surfacing both, labeled distinctly, rather than picking one and letting the UI imply the wrong claim.

**API**: `GET /stats/leaderboard?window=week` → `{ topOperators: [{operator, distinctAircraft}], rarestTypesAllTime: [{typecode, model, distinctAircraft}], newTypesToday: NotableAircraft[] }` (the third field reuses §17.2's existing query directly).

**Frontend**: new rail panel, same `Panel`/`PanelHeader` shell as `TrafficVolumePanel`/`NeighborhoodAnalyticsPanel` — two simple ranked lists, no map interaction needed.

**Out of scope**: cross-referencing operator against a livery/branding asset (logos, colors) — text-only leaderboard for v1.

## 20. Rare-Aircraft Alerts / "Spotter Mode" (v2 — spec only)

Goal: notify a user when a rare or notable aircraft type appears in the region — a third watch kind alongside the two already built in the alerts feature (§2: `alert_watches`, `push_subscriptions`, `AlertsPanel.tsx`, `frontend/src/lib/push.ts`), which today covers "notify me when a specific `icao24` reappears" and "notify me when something enters a geo-zone." This reuses that infrastructure rather than building new delivery plumbing.

**Two trigger modes**, both cheap given what's already computed per poll:
1. **"New to this station"** — reuses the exact `first_seen`-today definition already established for the digest's notable-aircraft fact (§17.2). No new detection logic, just a new consumer of the same signal.
2. **Curated type watch** — a static allow-list of specific typecodes a user can subscribe to (e.g. 747, A380, military types) rather than a computed global rarity score — keeps the feature's scope to "watch for things I've told you I care about," matching the existing `icao24`-watch's specificity, rather than inventing and maintaining a rarity metric.

**Where the check runs.** `ingestion`'s per-poll enrichment already classifies typecode/category before writing the enriched record to Redis (`attachAircraftType.ts`). The rare-type match should happen in that same per-poll pass, alongside wherever the existing `icao24`-watch / geo-zone-watch matching currently runs — not a separate polling job — so delivery reuses the existing web-push path with zero new infrastructure.

**Schema.** Extend `alert_watches` with a `kind` discriminator value (`icao24 | geo_zone | rare_type`, assuming the first two aren't already modeled as separate tables) and a `typecodes: text[]` (or `NULL` to mean "any new-to-station type," covering trigger mode 1).

**Frontend.** Extend `AlertsPanel.tsx` with a third watch-creation flow ("Notify me about rare aircraft") alongside the existing `icao24`/geo-zone flows — a toggle for "any new type" vs. a multi-select against a small curated typecode list.

**Out of scope.** Building or maintaining a global/statistical rarity database — scope is deliberately limited to "new to this station" (already computed) or a static curated list, never a computed rarity score requiring its own upkeep.

## 21. METAR Weather Overlay (v2 — spec only)

Goal: surface live wind direction/speed (and secondarily visibility/ceiling) for the 5 regional fields. The sharper angle beyond generic weather trivia: wind direction is mechanically *why* a given runway flow (§15) is active, so pairing the two turns the flow badge from a bare fact into a fact plus its cause — "South Flow" reads differently next to "Wind 180@12kt" than alone.

**Data source.** `aviationweather.gov`'s free, keyless METAR API (`https://aviationweather.gov/api/data/metar?ids=KSEA,KPAE,KBFI,KRNT,KTIW&format=json`) — no registration, no rate limit, matching the "free, no API key" sourcing this project has used for every prior integration (OpenSky excepted, which does require a free registered account per §4).

**Refresh cadence.** METAR observations update roughly hourly (more often in rapidly changing conditions) — poll every 10–15 min per field, the same cadence class as the flow-direction TTL (§15's `airport:flow:{icao}`, 10 min). Implementation: either a small standalone worker matching `fidsRefreshWorker.ts`'s pattern, or folded into the existing flow-direction refresh cycle in `ingestion` since both are field-scoped, slow-moving, and already on a similar timer.

**Storage.** Redis only — `airport:metar:{icao}` → `{ windDirDeg, windSpeedKt, visibilitySm, skyCondition, rawText, observedAt }`, short TTL so a stale reading self-clears if the worker stops. No Postgres persistence: unlike `positions`, there's no replay/analytics value in warehousing observations NOAA already archives.

**API.** `GET /airports/:icao/weather` — a plain Redis GET, mirroring `GET /airports/:icao/flow` (§15) exactly.

**Frontend.** Extend `FlowBadge.tsx` (or a sibling badge sharing its rotation logic) to show wind alongside flow direction, e.g. `"SEA: South Flow (rwy 16) · Wind 180@12kt"` — reinforcing the causal link rather than presenting two unrelated facts. Raw METAR text available behind a tooltip/expansion for aviation-literate users who want the full station report.

**Out of scope.** TAF (forecast) data, and any rendered precipitation/radar layer on the map itself — this is station-observation text data only, not a weather visualization layer.
