#!/usr/bin/env bash
# One-command deploy to the EC2 kubeadm cluster (Phase 2, docs/SPEC.md §9).
# Assumes the cluster itself is already bootstrapped (k8s/bootstrap-ec2-cluster.sh,
# one-time) and the SSM port-forward tunnel to the control-plane is open:
#
#   aws ssm start-session --region us-west-2 --target <control-plane-instance-id> \
#     --document-name AWS-StartPortForwardingSession \
#     --parameters '{"portNumber":["6443"],"localPortNumber":["6443"]}'
#
# See k8s/README.md "EC2 cluster" section for the full one-time setup.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export KUBECONFIG=k8s/ec2-kubeconfig

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

if ! kubectl get nodes >/dev/null 2>&1; then
  echo "ERROR: can't reach the ec2 cluster API server." >&2
  echo "  Is the SSM port-forward tunnel open? See k8s/README.md 'EC2 cluster'." >&2
  exit 1
fi

log "Building + pushing images to ECR"
bash k8s/push-ecr.sh

log "Creating/updating secrets"
bash k8s/create-secrets-ec2.sh

log "Deploying manifests"
kubectl apply -k k8s/overlays/ec2

log "Waiting for schema-init Job to complete"
kubectl wait --namespace pugetscope --for=condition=complete job/schema-init --timeout=120s

log "Restarting app deployments to pick up freshly-pushed images"
for svc in ingestion websocket api frontend; do
  kubectl rollout restart "deployment/$svc" -n pugetscope
done

log "Waiting for pods to become ready"
kubectl wait --namespace pugetscope --for=condition=ready pod \
  --selector='app in (api,ingestion,websocket,frontend)' --timeout=180s

log "Pods:"
kubectl get pods -n pugetscope

cat <<'EOF'

Stack is up. Open:  https://pugetscope.com/

Useful follow-ups:
  kubectl --kubeconfig k8s/ec2-kubeconfig get pods -n pugetscope -w
  kubectl --kubeconfig k8s/ec2-kubeconfig logs -n pugetscope deployment/ingestion -f
EOF
