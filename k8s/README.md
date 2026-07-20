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

kubectl apply -k k8s/overlays/local
```

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

**Known limitation: OpenSky Network appears to block AWS IP ranges.** Verified directly on both nodes and from inside pods: `auth.opensky-network.org` and `opensky-network.org` both hit a connection timeout, while unrelated HTTPS traffic (e.g. `example.com`) succeeds instantly — from the *node* itself, not just the pod network, ruling out a Flannel/security-group issue on our end. This is consistent with OpenSky blocking cloud-provider/datacenter IP ranges as an anti-scraping measure (a commonly reported behavior for that service). Practical effect: `ingestion` runs fine and reaches RDS/Redis, but its OpenSky polls fail, so no live aircraft data flows through this particular deployment. `api`/`frontend`/`websocket`, RDS/ElastiCache connectivity (including the SSL fix above), the Kustomize/ECR pipeline, and the full signup/login flow (including the `Secure` session cookie, which requires the real HTTPS domain to work at all) are all independently verified working. Options if this needs fixing: ask OpenSky for an allowlist exception, route ingestion's outbound traffic through a non-cloud egress path (e.g. a residential-IP proxy), or accept the limitation for this environment and keep relying on local dev for live-traffic testing. Not fixed here — needs a deliberate decision, not a silent workaround.

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
