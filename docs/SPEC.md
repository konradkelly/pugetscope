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
- Airport departures/arrivals dashboard (needs a schedule data source, separate integration) — partially unblocked already: FIDS (§12) already pulls this data for route-matching, just not surfaced as its own public-facing view.
- Flight playback/replay — the `positions` table has been accumulating full history (position/altitude/speed/heading per aircraft per poll) since ingestion went live; this is a query/UI problem against data already collected, not a new integration.
- Noise/overflight analytics by neighborhood — buckets overflights by neighborhood/zip polygon × time-of-day × altitude, using data already in `positions`. No new data source needed. First v2+ feature after routing; see §13.
- Traffic volume analytics — flights/hour, busiest times of day, day-of-week patterns, split by airport (KSEA vs. the 4 regional fields). Same `positions` table, aggregate rather than per-neighborhood.
- Runway/flow-direction inference — which configuration SEA is using right now, inferred from approach/departure headings already in `positions`. Feeds both the noise-analytics angle and general spotter interest.
- Aircraft/airline mix stats — busiest operator this week, rarest type spotted; leaderboard-flavored, builds on the reference-data enrichment already built (registration/manufacturer/model/operator, `ingestion/src/enrichment/`).
- Boeing Spotter Mode / rare-aircraft notifications
- Personal spotting log (auth-gated) — auto-confirmed against real ADS-B data rather than self-reported. The actual payoff for having real accounts (§6), which currently authenticate users into nothing.
- Saved watchlist + custom alert zones (auth-gated) — "notify me when N123AB is back in the area" / "notify me when something's over my house."
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
8. ~~Self-managed K8s on EC2 via kubeadm~~ — done: kubeadm-bootstrapped cluster (1 control-plane + 1 worker, Flannel CNI, baremetal/NodePort ingress-nginx) on the Phase 1 nodes, all via SSM (no SSH key exists on these instances by design). `k8s/` restructured to Kustomize (`base/` + `overlays/{local,ec2}`, with in-cluster Postgres/Redis pulled out into an opt-in `base/datastores` Component so `overlays/ec2` can use RDS/ElastiCache while `overlays/local` keeps k3d's in-cluster datastores — keeps the §9/§10 managed-vs-self-hosted question genuinely open). RDS schema bootstrapped via a one-off Job (Terraform can't run SQL); ECR image pulls need their own refreshed pull secret (self-managed kubelet has no built-in ECR credential provider, unlike EKS). See `k8s/README.md` "EC2 cluster" section for full details, including one thing surfaced during this pass and *not yet resolved*: OpenSky Network appears to block AWS IP ranges — `ingestion` reaches RDS/Redis fine but its OpenSky polls time out, verified at the node level, so no live aircraft data flows through this deployment yet. Also: the EC2 Terraform user-data was missing `conntrack`/`ebtables`/`socat` (kubeadm preflight deps, fixed in `terraform/modules/ec2/templates/node-init.sh.tpl` for future nodes) — installed by hand on the two live nodes, but applying that Terraform fix now would replace both running nodes (`user_data_replace_on_change = true`), so it's deliberately *not* applied yet.
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
- ⬜ **Not yet shipped to production** — the schema (`zip_boundaries` table + index) and loaded zip data are live in production Postgres, but the new `api` routes only exist in this checkout; deploying them means a real image build/push/rollout (`k8s/push-ecr.sh` + `kubectl rollout restart`, or via the GitHub Actions `deploy.yml` on push to `main`), deliberately not done without a separate go-ahead.
- ⬜ **No frontend yet** — backend/API scope only for this pass, by design (see conversation history for the scoping decision). A neighborhood-picker + hour-of-day chart is the natural next step once the API is live.
