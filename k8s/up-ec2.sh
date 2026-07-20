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

log "Waiting for the rollout to finish"
# kubectl rollout status watches the Deployment's own status, not individual
# pod objects — kubectl wait --selector=... raced with the rolling update
# here: it lists matching pods once, then waits on each, and an old pod
# terminating between that list and the wait made it exit 1 on a NotFound
# even though the new pods were already healthy (bit both a manual run and
# the first real CI run of this script).
for svc in ingestion websocket api frontend; do
  kubectl rollout status "deployment/$svc" -n pugetscope --timeout=180s
done

log "Pods:"
kubectl get pods -n pugetscope

cat <<'EOF'

Stack is up. Open:  https://pugetscope.com/

Useful follow-ups:
  kubectl --kubeconfig k8s/ec2-kubeconfig get pods -n pugetscope -w
  kubectl --kubeconfig k8s/ec2-kubeconfig logs -n pugetscope deployment/ingestion -f
EOF
