#!/bin/bash
# OS-level kubeadm prerequisites. Installs and configures containerd +
# kubelet/kubeadm/kubectl, but deliberately does NOT run `kubeadm init` or
# `kubeadm join` — that's a Phase 2 step (SPEC.md §9), run manually/via a
# separate script once all nodes exist and their IPs are known.
set -euxo pipefail

hostnamectl set-hostname "${hostname}"

# --- Disable swap (kubelet hard-requires this) ---
swapoff -a
sed -i '/ swap / s/^/#/' /etc/fstab

# --- Kernel modules + sysctl required for pod networking ---
cat <<'EOF' > /etc/modules-load.d/k8s.conf
overlay
br_netfilter
EOF
modprobe overlay
modprobe br_netfilter

cat <<'EOF' > /etc/sysctl.d/k8s.conf
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF
sysctl --system

# --- containerd ---
apt-get update
apt-get install -y ca-certificates curl gnupg apt-transport-https

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y containerd.io

mkdir -p /etc/containerd
containerd config default > /etc/containerd/config.toml
sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
systemctl restart containerd
systemctl enable containerd

# --- kubelet / kubeadm / kubectl ---
curl -fsSL "https://pkgs.k8s.io/core:/stable:/v${k8s_minor_version}/deb/Release.key" \
  | gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v${k8s_minor_version}/deb/ /" \
  > /etc/apt/sources.list.d/kubernetes.list
apt-get update
apt-get install -y kubelet kubeadm kubectl

# kubeadm preflight requires these but doesn't install them itself — found by
# `kubeadm init` failing with `[ERROR FileExisting-conntrack]` on a from-scratch
# node.
apt-get install -y conntrack ebtables ethtool socat

apt-mark hold kubelet kubeadm kubectl

systemctl enable kubelet
