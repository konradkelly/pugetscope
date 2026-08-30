#!/usr/bin/env bash
# Builds and pushes all 4 service images to ECR as multi-arch (amd64 + arm64)
# manifest lists, tagged :ec2-latest. Mirrors up.sh's build_and_push, but
# targeting ECR instead of the local k3d registry.
# Frontend gets a genuinely different image than local — Vite bakes
# VITE_API_URL/VITE_WS_URL in at build time (frontend/Dockerfile), so this
# isn't just a retag of the local image.
set -euo pipefail

REGION=us-west-2
ACCOUNT_ID=675901257165
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
TAG=ec2-latest
DOMAIN="pugetscope.com"

# The EC2 cluster is mixed-architecture: the control plane is x86_64 and the
# worker is Graviton/arm64 (terraform/modules/ec2, SPEC.md §9). Nothing pins
# these Deployments to a particular node, so every image has to run on either
# one — a single-arch image doesn't fail at deploy time, it fails whenever the
# scheduler happens to place a pod on the other node, as "exec format error"
# in a CrashLoopBackOff.
PLATFORMS=linux/amd64,linux/arm64
BUILDER=pugetscope-multiarch

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

log "Logging in to ECR ($REGISTRY)"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

# Multi-platform builds need the docker-container driver; the default "docker"
# driver can only produce a single image for the local daemon's own store.
# Cross-building the per-target runtime stages also needs binfmt/QEMU handlers
# registered — Docker Desktop ships them, CI installs them via
# docker/setup-qemu-action (.github/workflows/deploy.yml).
log "Ensuring buildx builder ($BUILDER)"
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  docker buildx create --name "$BUILDER" --driver docker-container --bootstrap
fi
docker buildx use "$BUILDER"

# --push rather than --load: a manifest list can't be loaded into the local
# docker image store, so there's no build-then-push split here as there was
# with the classic builder.
#
# --provenance=false: buildx otherwise attaches a SLSA provenance manifest to
# the index, which lands in ECR as an extra entry with platform unknown/unknown.
# Kubernetes ignores it, but the ECR lifecycle policy (terraform/modules/ecr)
# expires untagged images after 3 days, so it would be steadily reaping
# attestations belonging to a live image in exchange for nothing.
build_push() {
  local svc="$1"
  shift
  log "Building + pushing $svc ($PLATFORMS)"
  docker buildx build \
    --platform "$PLATFORMS" \
    --provenance=false \
    -t "$REGISTRY/pugetscope/$svc:$TAG" \
    "$@" \
    --push "./$svc"
}

for svc in ingestion websocket api; do
  build_push "$svc"
done

build_push frontend \
  --build-arg VITE_API_URL="https://${DOMAIN}/api" \
  --build-arg VITE_WS_URL="wss://${DOMAIN}/live" \
  --build-arg VITE_VAPID_PUBLIC_KEY="${VITE_VAPID_PUBLIC_KEY:-}"

log "All images pushed to $REGISTRY (tag: $TAG, platforms: $PLATFORMS)"
