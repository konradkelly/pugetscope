# k8s

Raw YAML manifests — no Kustomize/Helm yet, per docs/SPEC.md §9 (Kustomize is deliberately deferred to Phase 2, once there's a real local-vs-EC2 config diff to manage). Phase 0: local `k3d` only.

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

kubectl apply -f k8s/base/
```

Images reference the in-cluster registry as `pugetscope-registry:5000/...` (the container's actual Docker network name — not `k3d-pugetscope-registry`, despite that being the convention for other k3d-managed resources).

## Accessing the app

http://pugetscope.127.0.0.1.nip.io:8081 — `nip.io` resolves that hostname to 127.0.0.1 publicly, avoiding any edits to the Windows hosts file. The Ingress is split into two resources (`pugetscope-api`, `pugetscope-app`) rather than one, because nginx-ingress's `rewrite-target` annotation applies to every path rule on an Ingress, not just the one that needs it — a single Ingress with the `/api` rewrite also silently rewrote `/live` (the websocket path) via its empty capture group, which took an extra debugging pass to catch when `/live` returned 404 despite `/api` working.

## Rebuilding after a code change

```
docker build -t localhost:5000/pugetscope-<service>:latest ./<service>
docker push localhost:5000/pugetscope-<service>:latest
kubectl rollout restart deployment/<service> -n pugetscope
```
