#!/usr/bin/env bash
# Creates k8s Secrets for the ec2 overlay. Mirrors create-secrets.sh, but
# postgres-credentials comes live from Secrets Manager (Terraform-generated
# RDS password, terraform/modules/rds/main.tf) instead of a hand-set local
# value. OPENSKY/AERODATABOX creds are the same third-party API keys
# regardless of which cloud infra runs the app, so they're still read from
# the existing local k8s/secrets.env.
#
# Requires: the SSM port-forward tunnel to the control-plane running (see
# k8s/README.md "EC2 cluster" section) and KUBECONFIG=k8s/ec2-kubeconfig.
set -euo pipefail

cd "$(dirname "$0")/.."

REGION=us-west-2
export KUBECONFIG=k8s/ec2-kubeconfig

if [ ! -f k8s/secrets.env ]; then
  echo "Missing k8s/secrets.env — copy secrets.env.example and fill in real values first." >&2
  exit 1
fi

set -a
source k8s/secrets.env
set +a

kubectl create namespace pugetscope --dry-run=client -o yaml | kubectl apply -f -

echo "Fetching RDS credentials from Secrets Manager (pugetscope/rds/postgres)..."
RDS_SECRET_JSON="$(aws secretsmanager get-secret-value --region "$REGION" --secret-id pugetscope/rds/postgres --query SecretString --output text)"
RDS_USER="$(echo "$RDS_SECRET_JSON" | python -c 'import json,sys; print(json.load(sys.stdin)["username"])')"
RDS_PASSWORD="$(echo "$RDS_SECRET_JSON" | python -c 'import json,sys; print(json.load(sys.stdin)["password"])')"
RDS_DB="$(echo "$RDS_SECRET_JSON" | python -c 'import json,sys; print(json.load(sys.stdin)["dbname"])')"

kubectl create secret generic postgres-credentials \
  --namespace pugetscope \
  --from-literal=POSTGRES_USER="$RDS_USER" \
  --from-literal=POSTGRES_PASSWORD="$RDS_PASSWORD" \
  --from-literal=POSTGRES_DB="$RDS_DB" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic opensky-credentials \
  --namespace pugetscope \
  --from-literal=OPENSKY_CLIENT_ID="$OPENSKY_CLIENT_ID" \
  --from-literal=OPENSKY_CLIENT_SECRET="$OPENSKY_CLIENT_SECRET" \
  --from-literal=OPENSKY_PROXY_URL="${OPENSKY_PROXY_URL:-}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic aerodatabox-credentials \
  --namespace pugetscope \
  --from-literal=AERODATABOX_API_KEY="${AERODATABOX_API_KEY:-}" \
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

# ECR image pulls need auth (unlike EKS, self-managed kubelet has no built-in
# ECR credential provider). The token is only valid ~12h, so this secret is
# only as fresh as the last `create-secrets-ec2.sh` / `up-ec2.sh` run — fine
# for a project that isn't kept running 24/7, but a pod rescheduled >12h
# after the last deploy could hit ImagePullBackOff until the next redeploy.
echo "Refreshing ECR image pull secret..."
ECR_TOKEN="$(aws ecr get-login-password --region "$REGION")"
kubectl create secret docker-registry ecr-registry \
  --namespace pugetscope \
  --docker-server="675901257165.dkr.ecr.${REGION}.amazonaws.com" \
  --docker-username=AWS \
  --docker-password="$ECR_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Secrets created/updated in namespace pugetscope (ec2 cluster)."
