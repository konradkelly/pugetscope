#!/usr/bin/env bash
# One-time kubeadm cluster bootstrap on the Phase 1 EC2 nodes (docs/SPEC.md §9
# Phase 2). Driven entirely through SSM send-command — no SSH key exists on
# these instances (see terraform/modules/iam, SSM-only access by design).
#
# Not meant to be re-run against an already-bootstrapped cluster — kubeadm
# init is a one-shot operation. Re-running this against the live cluster
# nodes would fail (or worse) since a control-plane already exists.
#
# Requires: aws CLI configured, --region us-west-2 (the CLI's default region
# is NOT us-west-2 — every call below is explicit about it for that reason).
set -euo pipefail

REGION=us-west-2
CP_ID=i-088950a16ff0ecb07     # pugetscope-control-plane-1
CP_PRIVATE_IP=10.0.0.235
WORKER_ID=i-0d165d0db0c5dc237  # pugetscope-worker-1
POD_CIDR=10.244.0.0/16

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

run_on() {
  local instance_id="$1" desc="$2" commands="$3"
  log "$desc"
  local cmd_id
  cmd_id="$(aws ssm send-command --region "$REGION" \
    --instance-ids "$instance_id" \
    --document-name "AWS-RunShellScript" \
    --timeout-seconds 600 \
    --parameters "commands=${commands}" \
    --query "Command.CommandId" --output text)"
  aws ssm wait command-executed --region "$REGION" \
    --command-id "$cmd_id" --instance-id "$instance_id" 2>/dev/null || true
  aws ssm get-command-invocation --region "$REGION" \
    --command-id "$cmd_id" --instance-id "$instance_id" \
    --query "{Status:Status,Out:StandardOutputContent,Err:StandardErrorContent}" --output text
}

# --- 1. kubeadm preflight deps (already baked into terraform/modules/ec2's
#        user-data going forward — kept here too since this script should
#        work standalone against nodes provisioned before that fix landed).
run_on "$CP_ID" "Installing conntrack/ebtables/socat (control-plane)" \
  '["apt-get update -qq","apt-get install -y conntrack ebtables ethtool socat"]'
run_on "$WORKER_ID" "Installing conntrack/ebtables/socat (worker)" \
  '["apt-get update -qq","apt-get install -y conntrack ebtables ethtool socat"]'

# --- 2. kubeadm init on control-plane ---
# --apiserver-cert-extra-sans=127.0.0.1 is required for the SSM port-forward
# tunnel (Step 2 in k8s/README.md's EC2 section) to pass TLS verification —
# without it the server cert isn't valid for 127.0.0.1 and kubectl fails
# with a x509 error through the tunnel.
run_on "$CP_ID" "kubeadm init" \
  "[\"kubeadm init --pod-network-cidr=${POD_CIDR} --apiserver-advertise-address=${CP_PRIVATE_IP} --apiserver-cert-extra-sans=127.0.0.1 --cri-socket=unix:///run/containerd/containerd.sock\"]"

echo ""
echo "Copy the 'kubeadm join ...' command from the output above, then:"
echo "  JOIN_CMD='<paste here>' bash -c 'aws ssm send-command --region $REGION --instance-ids $WORKER_ID --document-name AWS-RunShellScript --parameters commands=\"[\\\"\$JOIN_CMD --cri-socket=unix:///run/containerd/containerd.sock\\\"]\"'"
echo ""
read -rp "Paste the full 'kubeadm join ...' command now, or Ctrl-C to do it manually later: " JOIN_CMD

# --- 3. Flannel CNI ---
run_on "$CP_ID" "Installing Flannel" \
  '["export KUBECONFIG=/etc/kubernetes/admin.conf","mkdir -p /root/.kube && cp /etc/kubernetes/admin.conf /root/.kube/config","kubectl apply -f https://github.com/flannel-io/flannel/releases/latest/download/kube-flannel.yml"]'

# --- 4. Join the worker ---
run_on "$WORKER_ID" "Joining worker to the cluster" \
  "[\"${JOIN_CMD} --cri-socket=unix:///run/containerd/containerd.sock\"]"

# --- 5. Fetch admin.conf, rewrite server to 127.0.0.1 for the SSM tunnel ---
# Piped directly to a file (never through this script's own stdout capture)
# to avoid transcription risk with the embedded certificate base64 blobs.
log "Fetching kubeconfig -> k8s/ec2-kubeconfig"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CMD_ID="$(aws ssm send-command --region "$REGION" \
  --instance-ids "$CP_ID" \
  --document-name "AWS-RunShellScript" \
  --timeout-seconds 30 \
  --parameters 'commands=["sed \"s#server: https://'"${CP_PRIVATE_IP}"':6443#server: https://127.0.0.1:6443#\" /etc/kubernetes/admin.conf"]' \
  --query "Command.CommandId" --output text)"
aws ssm wait command-executed --region "$REGION" --command-id "$CMD_ID" --instance-id "$CP_ID" 2>/dev/null || true
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$CP_ID" \
  --query "StandardOutputContent" --output text > "$ROOT/k8s/ec2-kubeconfig"

log "Done. Open the SSM tunnel (see k8s/README.md 'EC2 cluster'), then:"
echo "  KUBECONFIG=k8s/ec2-kubeconfig kubectl get nodes"
