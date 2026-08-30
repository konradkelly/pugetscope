# k8s

Raw YAML manifests (`base/`) composed with Kustomize (`overlays/local`, `overlays/ec2`) per docs/SPEC.md §9 — Kustomize was deliberately deferred until Phase 2 gave a real local-vs-EC2 config diff to manage, rather than introduced upfront. `base/` still holds the actual resource definitions; overlays only patch environment-specific bits (image registry, datastore host, ingress hostname).

## TL;DR — one command

```
cp k8s/secrets.env.example k8s/secrets.env   # first time only: fill in OPENSKY_CLIENT_ID / SECRET
bash k8s/up.sh
```

`up.sh` auto-detects cluster state and does the right thing: full setup if the cluster doesn't exist, `k3d cluster start` if it exists but is stopped, or rebuild-push-redeploy the app services if it's already running. The rest of this README documents each step manually for when you want to run them individually or understand what `up.sh` is doing.

To stop without destroying anything (keeps DB data + images): `k3d cluster stop pugetscope`.

## One-time cluster setup

```
k3d cluster create pugetscope \
  --port "8081:80@loadbalancer" \
  --port "8444:443@loadbalancer" \
  --registry-create pugetscope-registry:0.0.0.0:5000 \
  --k3s-arg "--disable=traefik@server:0"

kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/cloud/deploy.yaml
kubectl wait --namespace ingress-nginx --for=condition=ready pod --selector=app.kubernetes.io/component=controller --timeout=120s
```

Traefik (k3s's default ingress) is disabled in favor of nginx-ingress, installed via its own upstream raw manifest — not Helm — matching the Phase 0 manifest-management decision. Ports 8081/8444 were picked because 8080/8443 were already taken locally (Docker Desktop); adjust if they're free on your machine, but you'll also need to update every `pugetscope.127.0.0.1.nip.io:8081` reference in `k8s/base/*.yaml` and `frontend/Dockerfile` to match.

**Windows note**: k3d's generated kubeconfig points `kubectl` at `host.docker.internal`, which didn't resolve correctly in this environment. If `kubectl get nodes` hangs, find the real host port docker mapped for the API server (`docker ps | grep serverlb`, look for `->6443/tcp`) and run:
```
kubectl config set-cluster k3d-pugetscope --server=https://127.0.0.1:<that-port>
```

## Secrets

Not committed. Copy the template and fill in real values, then run the creation script:
```
cp k8s/secrets.env.example k8s/secrets.env   # fill in OPENSKY_CLIENT_ID / SECRET
bash k8s/create-secrets.sh
```

## Build, push, deploy

```
for svc in ingestion websocket api frontend; do
  docker build -t localhost:5000/pugetscope-$svc:latest ./$svc
  docker push localhost:5000/pugetscope-$svc:latest
done

kubectl kustomize --load-restrictor=LoadRestrictionsNone k8s/overlays/local | kubectl apply -f -
```

Plain `kubectl apply -k` won't work here — `postgres-init`'s `configMapGenerator` (`base/kustomization.yaml`) reads `db/init/001_schema.sql` from outside `k8s/base` on purpose, so both files stay one source of truth instead of drifting the way they once did. That's only allowed through the standalone `kubectl kustomize` subcommand's `--load-restrictor` flag, not `apply -k`'s.

`overlays/local`'s `images:` transformer remaps the bare `pugetscope/<service>:latest` names in `base/*.yaml` to the in-cluster registry `pugetscope-registry:5000/...` (the container's actual Docker network name — not `k3d-pugetscope-registry`, despite that being the convention for other k3d-managed resources). It also pulls in the `base/datastores` Kustomize Component (Postgres + Redis as in-cluster Deployments) — the `ec2` overlay deliberately doesn't, see below.

## Accessing the app

http://pugetscope.127.0.0.1.nip.io:8081 — `nip.io` resolves that hostname to 127.0.0.1 publicly, avoiding any edits to the Windows hosts file. The Ingress is split into two resources (`pugetscope-api`, `pugetscope-app`) rather than one, because nginx-ingress's `rewrite-target` annotation applies to every path rule on an Ingress, not just the one that needs it — a single Ingress with the `/api` rewrite also silently rewrote `/live` (the websocket path) via its empty capture group, which took an extra debugging pass to catch when `/live` returned 404 despite `/api` working.

## Rebuilding after a code change

```
docker build -t localhost:5000/pugetscope-<service>:latest ./<service>
docker push localhost:5000/pugetscope-<service>:latest
kubectl rollout restart deployment/<service> -n pugetscope
```

## EC2 cluster (Phase 2, docs/SPEC.md §9)

Self-managed kubeadm cluster on the Phase 1 Terraform EC2 nodes: 1 control-plane (`pugetscope-control-plane-1`) + 1 worker (`pugetscope-worker-1`), Flannel CNI, baremetal (NodePort) ingress-nginx. No SSH key exists on these instances by design — everything below goes through SSM.

**One-time cluster bootstrap** (already done for the current cluster — only needed again after a full rebuild): `bash k8s/bootstrap-ec2-cluster.sh`, then install ingress-nginx:
```
export KUBECONFIG=k8s/ec2-kubeconfig
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/baremetal/deploy.yaml
kubectl wait --namespace ingress-nginx --for=condition=ready pod --selector=app.kubernetes.io/component=controller --timeout=120s
```
Baremetal, not cloud — the cloud variant creates a `Service type: LoadBalancer` that stays `<pending>` forever with no cloud-controller-manager/MetalLB. Baremetal creates a `NodePort` Service instead. Its ports were then pinned to the standard 80/443 (`kubectl patch svc ingress-nginx-controller -n ingress-nginx --type=json -p='[{"op":"replace","path":"/spec/ports/0/nodePort","value":80},{"op":"replace","path":"/spec/ports/1/nodePort","value":443}]'`) instead of the auto-assigned high ports, which needed `--service-node-port-range=80-32767` added to the kube-apiserver static pod manifest first (`/etc/kubernetes/manifests/kube-apiserver.yaml`, default range is 30000-32767 — 80/443 aren't in it). The security group already permits both (`terraform/modules/security_groups`: explicit 80/443 rules, separately from the 30000-32767 NodePort range).

**kubectl access** — 6443 is intentionally not open to the internet (`admin_cidrs` is empty in Terraform). Tunnel through SSM instead, in its own terminal:
```
aws ssm start-session --region us-west-2 --target i-088950a16ff0ecb07 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["6443"],"localPortNumber":["6443"]}'
```
Then `KUBECONFIG=k8s/ec2-kubeconfig kubectl get nodes` works normally. `k8s/ec2-kubeconfig` is gitignored (cluster admin credentials) and already has its `server:` rewritten to `https://127.0.0.1:6443` to match the tunnel.

**Deploy**: `bash k8s/up-ec2.sh` — builds+pushes all 4 images to ECR (`push-ecr.sh`), refreshes secrets including a fresh ECR pull token (`create-secrets-ec2.sh`), applies `overlays/ec2`, waits for the `schema-init` Job (bootstraps the RDS schema — Terraform can't run SQL) and all app pods to be ready.

**One-time step after the traffic-rollup migration ships**: `traffic_daily_counts`/`traffic_hourly_counts` (see `db/init/001_schema.sql`) are only populated going forward by `ingestion`'s poll loop (today + yesterday, every cycle). Any `positions` history from before this shipped needs a manual one-time backfill:
```
export KUBECONFIG=k8s/ec2-kubeconfig
kubectl exec -n pugetscope deploy/ingestion -- node dist/backfillTrafficRollup.js
```
Same one-time-manual-script convention as `enrich`/`load-zips` (`ingestion/package.json`) — not run automatically by `up-ec2.sh`, and safe to re-run (upserts, `ON CONFLICT ... DO UPDATE`). Run the compiled `dist/*.js` file directly, **not** `npm run backfill-rollup` — that script shells out to `tsx src/backfillTrafficRollup.ts`, but the runtime image (`ingestion/Dockerfile`) only ever copies `dist/` in, and `tsx` itself is a devDependency pruned by `npm ci --omit=dev`, so the `npm run` form 127s (`tsx: not found`) against a deployed pod every time — confirmed live while running the overflight backfill below for the first time.

**Same step for `overflight_hourly_counts`** (neighborhood noise analytics' own rollup table, `ingestion/src/db/overflightRollup.ts`) — identical rationale and convention, easy to forget as a *second* backfill since it's easy to only remember the traffic one above:
```
export KUBECONFIG=k8s/ec2-kubeconfig
kubectl exec -n pugetscope deploy/ingestion -- node dist/backfillOverflightRollup.js
```
Same `node dist/*.js`, not `npm run`, caveat as above. This one also backfills one LA date at a time internally (`backfillOverflightRollup.ts`) rather than the whole range in a single query like the traffic backfill does — confirmed live that a single call covering all of `positions`'s ~17 retained days timed out at 120s (ST_Intersects against zip polygons is pricier per row than traffic's ST_DWithin-from-a-point, and since `positions` only retains a couple weeks, "backfill everything" isn't a selective predicate — the same non-selective-predicate failure mode `docs/rollup-tables.md` documents, just hitting the one-time backfill instead of a live request).

**Automated deploys**: `.github/workflows/deploy.yml` runs this same `up-ec2.sh` on every push to `main` (or manually via `gh workflow run deploy.yml` / the Actions tab). It authenticates to AWS via the `module.iam.github_actions` OIDC role (no stored AWS keys), opens the same SSM port-forward tunnel a human would, and reuses `push-ecr.sh`/`create-secrets-ec2.sh`/`up-ec2.sh` unmodified. Deliberately does **not** run Terraform — infra changes stay a manual, `terraform plan`-checked step (see the EC2 drift note in `docs/SPEC.md` item 8). The manual flow above still works and is the fallback for debugging a failed deploy.

Access: **https://pugetscope.com/** — Route 53 (`terraform/modules/route53`) resolves it to a stable Elastic IP (`terraform/modules/ec2`'s `aws_eip.ingress`, attached to the control-plane node — functionally it doesn't matter which node holds it, kube-proxy forwards any node's NodePort traffic to the right pod regardless). Hostinger stays the domain registrar; its nameservers were pointed at the Route 53 zone's 4 `name_servers` (a manual one-time step — `terraform output route53_name_servers` to get them).

**TLS via cert-manager + Let's Encrypt.** Installed like ingress-nginx — the vendor's pinned static manifest, not Helm:
```
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml
kubectl wait --namespace cert-manager --for=condition=ready pod --all --timeout=120s
kubectl apply -f k8s/overlays/ec2/cluster-issuer.yaml
```
`cluster-issuer.yaml` defines the **production** `letsencrypt-prod` ClusterIssuer, but a **staging** issuer (`https://acme-staging-v02.api.letsencrypt.org/directory`) was used first to validate the ACME HTTP-01 flow end-to-end before switching — production has much stricter rate limits, not something to burn on a config that might be broken. `ClusterIssuer` is cluster-scoped, so it's applied directly rather than folded into `overlays/ec2`'s `kubectl apply -k` — Kustomize's `namespace:` transformer doesn't know this CRD kind and would incorrectly stamp a `namespace:` field onto it. Only `pugetscope-app`'s Ingress carries the `cert-manager.io/cluster-issuer` annotation and drives issuance; `pugetscope-api`'s Ingress just references the same `secretName` (`pugetscope-tls`) so both serve TLS from one certificate instead of cert-manager racing to create two `Certificate` resources for the same Secret.

**RDS requires SSL, and the Node `pg` client doesn't negotiate it by default.** Cost some debugging time: the `schema-init` Job's `psql` connected fine over plain TCP because libpq defaults to `sslmode=prefer` (tries SSL, uses it if offered) — but `api`/`ingestion`'s `pg.Pool` defaults to no SSL attempt at all, so it hit RDS's `pg_hba.conf` SSL-only rule and failed outright (`no pg_hba.conf entry for host ... no encryption`). Fixed with a `POSTGRES_SSL` toggle (`api/src/config.ts`, `ingestion/src/config.ts`) sourced from `datastore-config` — `true` in `overlays/ec2`, `false` in `overlays/local` (the in-cluster Postgres container has no SSL configured at all). Uses `rejectUnauthorized: false` (encrypted but not certificate-verified) since Node's default trust store doesn't include Amazon's RDS CA — a deliberate simplification, same tradeoff class as Redis having no AUTH/TLS.

**Mutable ECR tags need explicit `imagePullPolicy: Always`.** Kubernetes only defaults to `Always` for the *literal* tag `latest` — `ec2-latest` doesn't qualify, so a `kubectl rollout restart` after pushing a fresh image to the same tag silently kept running the node's locally cached (stale) image. All 4 app Deployments now set `imagePullPolicy: Always` explicitly (`k8s/base/*-deployment.yaml`) so every deploy actually re-pulls.

**ECR image pulls need their own auth.** Unlike EKS, self-managed kubelet has no built-in ECR credential provider — `create-secrets-ec2.sh` creates/refreshes a `docker-registry` Secret (`ecr-registry`), referenced via `imagePullSecrets` on all 4 app Deployments (patched in `overlays/ec2/kustomization.yaml`). The token is only valid ~12h, so it's only as fresh as the last deploy — a pod rescheduled long after the last `up-ec2.sh` run could hit `ImagePullBackOff` until the next one. Fine for a project that isn't kept running 24/7; the more correct fix (a kubelet image credential provider plugin using the node's IAM role, the same mechanism EKS uses under the hood) is a reasonable follow-up if this ever needs to be always-on.

**Fixed: OpenSky Network blocks AWS IP ranges — routed around via a forward proxy.** Originally discovered live on both nodes and from inside pods: `auth.opensky-network.org` and `opensky-network.org` both hit a connection timeout, while unrelated HTTPS traffic (e.g. `example.com`) succeeded instantly — from the *node* itself, not just the pod network, ruling out a Flannel/security-group issue on our end. Consistent with OpenSky blocking cloud-provider/datacenter IP ranges as an anti-scraping measure (a commonly reported behavior for that service). Of the options considered at the time (an OpenSky allowlist exception, a non-cloud egress proxy, or accepting the gap and relying on local dev for live-traffic testing), the middle one was built: `ingestion`'s OpenSky client (`openskyClient.ts`) routes both the states-poll and the aircraft-database CSV download through an optional non-AWS forward proxy (`OPENSKY_PROXY_URL`, `http://user:pass@host:port`, via `undici`'s `ProxyAgent`) when set, direct connection otherwise — so local dev (where the block doesn't apply) is unaffected. Wired through the same secret/config path as every other credential here: `OPENSKY_PROXY_URL` in `k8s/secrets.env` → `create-secrets-ec2.sh` → the `opensky-credentials` Secret → `k8s/base/ingestion-deployment.yaml` (`optional: true`, so an unset value degrades to direct-connection rather than failing the pod), and available as a `deploy.yml` GitHub secret for the CI-driven deploy path. Live aircraft data now flows through this deployment.

## Migrating a worker to Graviton

The cluster is deliberately mixed-architecture: workers run arm64 (`t4g.small`,
~19% cheaper per hour than `t3.small`), the control plane stays x86_64 until the
Phase 3 HA rebuild. Architecture follows from `instance_type` in
`terraform/variables.tf`'s `worker_nodes` map — there's no separate arch flag.

**You cannot resize across architectures.** `t3.small` → `t4g.small` is not a
stop/modify/start: the root volume holds an x86 AMI, so the instance has to be
replaced. This runbook adds the new node first and drains onto it, rather than
replacing in place, so there's no window where the app has nowhere to run.

Before starting, two preconditions:

1. **Images must be multi-arch already.** `push-ecr.sh` builds
   `linux/amd64,linux/arm64` manifest lists. Run a deploy and confirm before
   adding an arm64 node — a single-arch image doesn't fail at deploy time, it
   fails when the scheduler first lands a pod on the new node:
   ```
   aws ecr batch-get-image --region us-west-2 --repository-name pugetscope/api \
     --image-ids imageTag=ec2-latest --query 'images[].imageManifest' --output text | \
     python -c "import json,sys; print([m['platform'] for m in json.load(sys.stdin)['manifests']])"
   ```
2. **Check how `umami-postgres-data` is bound.** That PVC (`base/umami-postgres.yaml`)
   requests storage with no `storageClassName`, and this cluster has no CSI
   driver or dynamic provisioner — so whatever satisfies it was created by hand.
   If it's a hostPath/local PV pinned to `pugetscope-worker-1`, draining that
   node strands the claim and loses Umami's analytics history:
   ```
   kubectl get pvc umami-postgres-data -n pugetscope -o wide
   kubectl get pv "$(kubectl get pvc umami-postgres-data -n pugetscope -o jsonpath='{.spec.volumeName}')" -o yaml
   ```
   If it is node-local, `pg_dump` the Umami DB before draining and restore after.

Then:

```
# 1. Add the arm64 node (worker-1 keeps running; ~$0.02/hr for the overlap)
#    terraform/variables.tf:
#      worker_nodes = {
#        "worker-1" = { instance_type = "t3.small"  }
#        "worker-2" = { instance_type = "t4g.small" }
#      }
terraform -chdir=terraform apply

# 2. Join it. Token from the control plane, join command run on the new node,
#    both over SSM — these instances have no SSH key by design.
aws ssm start-session --target <control-plane-id> --region us-west-2
  sudo kubeadm token create --print-join-command

aws ssm start-session --target <worker-2-id> --region us-west-2
  sudo kubeadm join ...          # paste the command from above

# 3. Verify it came up as arm64 before trusting anything to it
kubectl get nodes -o wide
kubectl get node pugetscope-worker-2 -o jsonpath='{.status.nodeInfo.architecture}'   # -> arm64

# 4. Move the workload
kubectl cordon pugetscope-worker-1
kubectl drain pugetscope-worker-1 --ignore-daemonsets --delete-emptydir-data

# 5. Confirm the app is actually healthy on arm64 — not just Running
kubectl get pods -n pugetscope -o wide
curl -sf https://pugetscope.com/api/healthz     # -> {"ok":true}

# 6. Only then remove the old node, and drop it from worker_nodes
kubectl delete node pugetscope-worker-1
terraform -chdir=terraform apply
```

`--delete-emptydir-data` in step 4 is required and lossy-by-design: Prometheus's
TSDB and Grafana's sqlite are both `emptyDir` (see Observability below), so
scrape history doesn't survive the drain. That's the same tradeoff already made
for pod restarts, not a new one.

The Elastic IP stays on the control-plane node throughout, and ingress-nginx is
a NodePort Service, so kube-proxy keeps routing public traffic to wherever the
pods actually are — DNS never changes and no cert is reissued.

**Rolling back** at any point before step 6 is `kubectl uncordon
pugetscope-worker-1` plus removing `worker-2` from the map. After step 6 the x86
node is gone and rollback means provisioning a new one.

## Observability

Prometheus + Grafana (`k8s/base/prometheus-deployment.yaml`, `grafana-deployment.yaml`), scraping the `/metrics` endpoints already built into `api`, `websocket`, and `ingestion` (`*/src/metrics.ts`) — HTTP request rate/latency, live websocket connection count, OpenSky poll outcomes/duration, aircraft-in-region, and traffic/overflight rollup refresh duration (the query load `docs/rollup-tables.md` and the ROLLUP_REFRESH_INTERVAL_MS decoupling exist because of). A starter dashboard ("PugetScope Services") covering all of these is provisioned as code via a mounted ConfigMap, not clicked together in the UI.

**Internal-only, unlike Umami** — no Ingress, no public host. Both Services are ClusterIP; reach them with:
```
kubectl port-forward svc/prometheus 9090:9090 -n pugetscope
kubectl port-forward svc/grafana 3000:3000 -n pugetscope
```
Grafana login is `admin` / `GRAFANA_ADMIN_PASSWORD` (`k8s/secrets.env`, created by `create-secrets.sh`/`create-secrets-ec2.sh` like every other credential here). Grafana's own sqlite db (users/sessions) is an `emptyDir` — expendable, since the datasource and dashboard are reprovisioned from ConfigMaps on every pod restart regardless. Prometheus's TSDB is also an `emptyDir` (15d retention) for the same reason — scrape history is cheap to regenerate, not worth a PVC for a portfolio project's traffic volume.

Exposing Grafana publicly (its own subdomain + TLS, like Umami) is a deliberate follow-up decision, not done here — an internet-reachable dashboard is a different risk posture than an internet-reachable tracking-script collector.

## Analytics

Self-hosted [Umami](https://umami.is/) tracks pugetscope.com page views — neither Hostinger (registrar only) nor AWS record this out of the box. Own dedicated Postgres (`umami-postgres`, `k8s/base/umami-postgres.yaml`), deliberately separate from the main app DB and never forking to RDS — its storage needs are tiny, not worth a managed instance. `umami` itself (`k8s/base/umami-deployment.yaml`) is a public `ghcr.io` image, no ECR pull secret needed.

**Why it's public.** The tracking script embedded in `frontend/index.html` runs in *visitors'* browsers, so it needs a publicly reachable endpoint to report to — an internal-only Service isn't reachable from the public internet at all. It's exposed at `analytics.pugetscope.com` (own Route 53 record + a second SAN on the existing `pugetscope-tls` cert, `overlays/ec2/kustomization.yaml`), protected by Umami's own login — the standard way every self-hosted Umami/Plausible instance runs.

**EC2 needed a storage provisioner first.** No PVC had ever run on the EC2 kubeadm cluster before this — the main app uses RDS, which doesn't need one, and self-managed kubeadm has no default StorageClass (unlike k3d locally, or EKS). Installed Rancher's `local-path-provisioner` as a one-time add-on, same pattern as ingress-nginx/cert-manager:
```
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.30/deploy/local-path-storage.yaml
kubectl patch storageclass local-path -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

**One-time manual setup** (Umami has no env var to preseed this):
1. `kubectl port-forward svc/umami 3000:3000 -n pugetscope` (or visit `https://analytics.pugetscope.com/` once deployed) and log in with the default `admin`/`umami` — change the password immediately.
2. Add "pugetscope.com" as a tracked website in the Umami UI, copy its generated website ID.
3. Paste that ID into `frontend/index.html`'s `data-website-id` (replacing the `REPLACE_WITH_WEBSITE_ID` placeholder), rebuild + redeploy the frontend image.
