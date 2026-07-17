#!/usr/bin/env bash
# Creates k8s Secrets imperatively from a local, gitignored env file rather
# than committing Secret manifests with real values to the repo. Re-run after
# editing k8s/secrets.env — this deletes and recreates both Secrets.
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f secrets.env ]; then
  echo "Missing k8s/secrets.env — copy secrets.env.example and fill in real values first." >&2
  exit 1
fi

set -a
source secrets.env
set +a

kubectl create namespace pugetscope --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic postgres-credentials \
  --namespace pugetscope \
  --from-literal=POSTGRES_USER="$POSTGRES_USER" \
  --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  --from-literal=POSTGRES_DB="$POSTGRES_DB" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic opensky-credentials \
  --namespace pugetscope \
  --from-literal=OPENSKY_CLIENT_ID="$OPENSKY_CLIENT_ID" \
  --from-literal=OPENSKY_CLIENT_SECRET="$OPENSKY_CLIENT_SECRET" \
  --from-literal=OPENSKY_PROXY_URL="${OPENSKY_PROXY_URL:-}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Optional — AERODATABOX_API_KEY may be blank in secrets.env (FIDS disabled).
kubectl create secret generic aerodatabox-credentials \
  --namespace pugetscope \
  --from-literal=AERODATABOX_API_KEY="${AERODATABOX_API_KEY:-}" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Secrets created/updated in namespace pugetscope."
