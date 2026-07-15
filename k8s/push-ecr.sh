#!/usr/bin/env bash
# Builds and pushes all 4 service images to ECR, tagged :ec2-latest. Mirrors
# up.sh's build_and_push, but targeting ECR instead of the local k3d registry.
# Frontend gets a genuinely different image than local — Vite bakes
# VITE_API_URL/VITE_WS_URL in at build time (frontend/Dockerfile), so this
# isn't just a retag of the local image.
set -euo pipefail

REGION=us-west-2
ACCOUNT_ID=675901257165
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
TAG=ec2-latest
DOMAIN="pugetscope.com"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

log "Logging in to ECR ($REGISTRY)"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

for svc in ingestion websocket api; do
  log "Building + pushing $svc"
  docker build -t "$REGISTRY/pugetscope/$svc:$TAG" "./$svc"
  docker push "$REGISTRY/pugetscope/$svc:$TAG"
done

log "Building + pushing frontend (ec2 build args)"
docker build \
  --build-arg VITE_API_URL="https://${DOMAIN}/api" \
  --build-arg VITE_WS_URL="wss://${DOMAIN}/live" \
  -t "$REGISTRY/pugetscope/frontend:$TAG" ./frontend
docker push "$REGISTRY/pugetscope/frontend:$TAG"

log "All images pushed to $REGISTRY (tag: $TAG)"
