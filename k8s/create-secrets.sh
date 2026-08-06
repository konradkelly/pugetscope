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

# OPENSKY_PROXY_URL is deliberately not forwarded from secrets.env here —
# it's EC2-only (OpenSky blocks AWS IP ranges, see ingestion/src/config.ts
# and k8s/README.md's "Known limitation" note); local k3d ingestion doesn't
# need it and a stale value breaks local polling. create-secrets-ec2.sh
# reads the same secrets.env's OPENSKY_PROXY_URL for the real EC2 secret.
kubectl create secret generic opensky-credentials \
  --namespace pugetscope \
  --from-literal=OPENSKY_CLIENT_ID="$OPENSKY_CLIENT_ID" \
  --from-literal=OPENSKY_CLIENT_SECRET="$OPENSKY_CLIENT_SECRET" \
  --from-literal=OPENSKY_PROXY_URL="" \
  --dry-run=client -o yaml | kubectl apply -f -

# Optional — AERODATABOX_API_KEY may be blank in secrets.env (FIDS disabled).
kubectl create secret generic aerodatabox-credentials \
  --namespace pugetscope \
  --from-literal=AERODATABOX_API_KEY="${AERODATABOX_API_KEY:-}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Optional — ANTHROPIC_API_KEY may be blank in secrets.env (digest-generate
# CronJob no-ops without it, same gate as generateDigest.ts's local run).
kubectl create secret generic anthropic-credentials \
  --namespace pugetscope \
  --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Optional — both may be blank in secrets.env (push alerts disabled).
kubectl create secret generic push-credentials \
  --namespace pugetscope \
  --from-literal=VAPID_PUBLIC_KEY="${VAPID_PUBLIC_KEY:-}" \
  --from-literal=VAPID_PRIVATE_KEY="${VAPID_PRIVATE_KEY:-}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic umami-credentials \
  --namespace pugetscope \
  --from-literal=APP_SECRET="$UMAMI_APP_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic umami-db-credentials \
  --namespace pugetscope \
  --from-literal=POSTGRES_USER=umami \
  --from-literal=POSTGRES_PASSWORD="$UMAMI_DB_PASSWORD" \
  --from-literal=POSTGRES_DB=umami \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic grafana-credentials \
  --namespace pugetscope \
  --from-literal=GRAFANA_ADMIN_PASSWORD="$GRAFANA_ADMIN_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Secrets created/updated in namespace pugetscope."
