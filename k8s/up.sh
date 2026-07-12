#!/usr/bin/env bash
# One-command boot for the whole local stack. Detects whether the k3d cluster
# already exists and does the right thing:
#   - not created yet  -> full setup (cluster, ingress, build+push, secrets, deploy)
#   - created, stopped -> start it back up
#   - already running  -> (re)build+push images and re-apply manifests
# See k8s/README.md for the manual breakdown of each step.
set -euo pipefail

CLUSTER=pugetscope
REGISTRY=localhost:5000
INGRESS_VERSION=controller-v1.11.3
SERVICES=(ingestion websocket api frontend)

# repo root is the parent of this script's dir
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

build_and_push() {
  for svc in "${SERVICES[@]}"; do
    log "Building + pushing $svc"
    docker build -t "$REGISTRY/pugetscope-$svc:latest" "./$svc"
    docker push "$REGISTRY/pugetscope-$svc:latest"
  done
}

ensure_secrets() {
  if [ ! -f k8s/secrets.env ]; then
    echo "ERROR: k8s/secrets.env missing." >&2
    echo "  cp k8s/secrets.env.example k8s/secrets.env  and fill in OPENSKY_CLIENT_ID / SECRET" >&2
    exit 1
  fi
  log "Creating/updating secrets"
  bash k8s/create-secrets.sh
}

fix_kubeconfig_if_needed() {
  # On Windows/Docker-Desktop the generated kubeconfig points at
  # host.docker.internal, which may not resolve. If the API server is
  # unreachable, repoint kubectl at the real mapped 6443 host port.
  if kubectl get nodes >/dev/null 2>&1; then
    return
  fi
  log "kubectl can't reach the API server — repointing at 127.0.0.1"
  local port
  port="$(docker ps --filter "name=k3d-${CLUSTER}-serverlb" --format '{{.Ports}}' \
    | grep -oE '0\.0\.0\.0:[0-9]+->6443' | head -1 | grep -oE '[0-9]+' | head -1)"
  if [ -z "$port" ]; then
    echo "ERROR: couldn't find the mapped 6443 host port for the cluster." >&2
    exit 1
  fi
  kubectl config set-cluster "k3d-${CLUSTER}" --server="https://127.0.0.1:${port}"
}

full_setup() {
  log "Creating k3d cluster '$CLUSTER'"
  k3d cluster create "$CLUSTER" \
    --port "8081:80@loadbalancer" \
    --port "8444:443@loadbalancer" \
    --registry-create "pugetscope-registry:0.0.0.0:5000" \
    --k3s-arg "--disable=traefik@server:0"

  fix_kubeconfig_if_needed

  log "Installing nginx-ingress"
  kubectl apply -f "https://raw.githubusercontent.com/kubernetes/ingress-nginx/${INGRESS_VERSION}/deploy/static/provider/cloud/deploy.yaml"
  kubectl wait --namespace ingress-nginx \
    --for=condition=ready pod \
    --selector=app.kubernetes.io/component=controller --timeout=120s

  build_and_push
  ensure_secrets

  log "Deploying manifests"
  kubectl apply -f k8s/base/
}

# --- main -------------------------------------------------------------------

if ! k3d cluster list --output json | grep -q "\"name\":\"${CLUSTER}\""; then
  echo "Cluster '$CLUSTER' not found — running full setup."
  full_setup
else
  # exists — is it running? k3d reports serversRunning/serversCount
  running="$(k3d cluster list "$CLUSTER" --no-headers | awk '{print $2}')" # e.g. "1/1"
  if [ "$running" = "0/1" ] || [ "${running%/*}" = "0" ]; then
    log "Cluster exists but is stopped — starting it"
    k3d cluster start "$CLUSTER"
    fix_kubeconfig_if_needed
  else
    log "Cluster already running — rebuilding images and re-applying manifests"
    fix_kubeconfig_if_needed
    build_and_push
    ensure_secrets
    kubectl apply -f k8s/base/
    # Only bounce the app services to pick up freshly-pushed images — leave
    # postgres/redis alone so a code redeploy never cycles the database.
    for svc in "${SERVICES[@]}"; do
      kubectl rollout restart "deployment/$svc" -n pugetscope
    done
  fi
fi

log "Waiting for pods to become ready"
kubectl wait --namespace pugetscope \
  --for=condition=ready pod --all --timeout=180s || true

log "Pods:"
kubectl get pods -n pugetscope

cat <<'EOF'

Stack is up. Open:  http://pugetscope.127.0.0.1.nip.io:8081

Useful follow-ups:
  kubectl get pods -n pugetscope -w                       # watch pod states live
  kubectl logs -n pugetscope deployment/ingestion -f      # tail ingestion
  k3d cluster stop pugetscope                              # stop (keeps data + images)
EOF
