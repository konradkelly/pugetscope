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
Baremetal, not cloud — the cloud variant creates a `Service type: LoadBalancer` that stays `<pending>` forever with no cloud-controller-manager/MetalLB. Baremetal creates a `NodePort` Service instead, which the security group already permits (`terraform/modules/security_groups`, ports 30000-32767 open).

**kubectl access** — 6443 is intentionally not open to the internet (`admin_cidrs` is empty in Terraform). Tunnel through SSM instead, in its own terminal:
```
aws ssm start-session --region us-west-2 --target i-088950a16ff0ecb07 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["6443"],"localPortNumber":["6443"]}'
```
Then `KUBECONFIG=k8s/ec2-kubeconfig kubectl get nodes` works normally. `k8s/ec2-kubeconfig` is gitignored (cluster admin credentials) and already has its `server:` rewritten to `https://127.0.0.1:6443` to match the tunnel.

**Deploy**: `bash k8s/up-ec2.sh` — builds+pushes all 4 images to ECR (`push-ecr.sh`), refreshes secrets including a fresh ECR pull token (`create-secrets-ec2.sh`), applies `overlays/ec2`, waits for the `schema-init` Job (bootstraps the RDS schema — Terraform can't run SQL) and all app pods to be ready.

Access: `http://pugetscope.54.185.209.165.nip.io:31097/` — a temporary nip.io hostname tied to the worker node's current public IP + the ingress NodePort. Not durable: it'll change if the instance is stopped/started (no Elastic IP yet) or the ingress Service is recreated. Real domain (pugetscope.com) cutover is a deliberate later step, not part of Phase 2 — needs an Elastic IP first.

**ECR image pulls need their own auth.** Unlike EKS, self-managed kubelet has no built-in ECR credential provider — `create-secrets-ec2.sh` creates/refreshes a `docker-registry` Secret (`ecr-registry`), referenced via `imagePullSecrets` on all 4 app Deployments (patched in `overlays/ec2/kustomization.yaml`). The token is only valid ~12h, so it's only as fresh as the last deploy — a pod rescheduled long after the last `up-ec2.sh` run could hit `ImagePullBackOff` until the next one. Fine for a project that isn't kept running 24/7; the more correct fix (a kubelet image credential provider plugin using the node's IAM role, the same mechanism EKS uses under the hood) is a reasonable follow-up if this ever needs to be always-on.

**Known limitation: OpenSky Network appears to block AWS IP ranges.** Verified directly on both nodes and from inside pods: `auth.opensky-network.org` and `opensky-network.org` both hit a connection timeout, while unrelated HTTPS traffic (e.g. `example.com`) succeeds instantly — from the *node* itself, not just the pod network, ruling out a Flannel/security-group issue on our end. This is consistent with OpenSky blocking cloud-provider/datacenter IP ranges as an anti-scraping measure (a commonly reported behavior for that service). Practical effect: `ingestion` runs fine and reaches RDS/Redis, but its OpenSky polls fail, so no live aircraft data flows through this particular deployment. `api`/`frontend`/`websocket` and the RDS/ElastiCache/Kustomize/ECR pipeline are all independently verified working. Options if this needs fixing: ask OpenSky for an allowlist exception, route ingestion's outbound traffic through a non-cloud egress path (e.g. a residential-IP proxy), or accept the limitation for this environment and keep relying on local dev for live-traffic testing. Not fixed here — needs a deliberate decision, not a silent workaround.
