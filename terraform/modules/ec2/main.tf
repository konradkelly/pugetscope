# One AMI lookup per CPU architecture. The cluster is deliberately mixed-arch
# during the Graviton migration (SPEC.md §9): workers move to arm64 (t4g) for
# the ~19% hourly saving, while the control plane stays x86_64 until the Phase
# 3 HA rebuild, since replacing the single control-plane node is a downtime
# event and not something to bundle into a cost change.
data "aws_ami" "ubuntu_amd64" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

data "aws_ami" "ubuntu_arm64" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

locals {
  # One map entry per node, e.g. { "control-plane-1" = {...}, "worker-1" = {...}, "worker-2" = {...} }
  # so nodes are addressable individually in state instead of shifting on count changes.
  #
  # Workers are a map rather than a count for exactly that reason: the Graviton
  # migration runs a mixed x86/arm64 worker pair for as long as it takes to
  # drain the old node, and a count can't express "remove worker-1, keep
  # worker-2" — lowering a count removes the highest-numbered entry, which is
  # the new node, not the drained one.
  #
  # subnet_index is explicit per node instead of derived from position in this
  # map. It used to be `index(keys(local.nodes), each.key) % length(subnets)`,
  # which is stable only while the set of nodes is: removing worker-1 shifts
  # worker-2 from index 2 to 1, changing its subnet and forcing a replacement
  # of a node that was supposed to be the survivor. Pinning it keeps the
  # decommission step a pure delete.
  nodes = merge(
    { for i in range(var.control_plane_count) : "control-plane-${i + 1}" => {
      role          = "control-plane"
      instance_type = var.control_plane_instance_type
      subnet_index  = i % length(var.public_subnet_ids)
    } },
    { for name, cfg in var.worker_nodes : name => {
      role          = "worker"
      instance_type = cfg.instance_type
      subnet_index  = cfg.subnet_index
    } },
  )

  # Graviton families encode arm64 in the family name — a "g" immediately after
  # the generation digit (t4g, m7g, c7gn, r6gd). Deriving the AMI from
  # instance_type means there is no separate architecture variable that can
  # drift out of sync with it; that mismatch would surface as an instance that
  # boots into nothing, with no hint in the plan as to why.
  node_ami = {
    for name, cfg in local.nodes : name => (
      can(regex("^[a-z]+[0-9]+g[a-z]*\\.", cfg.instance_type))
      ? data.aws_ami.ubuntu_arm64.id
      : data.aws_ami.ubuntu_amd64.id
    )
  }
}

resource "aws_instance" "node" {
  for_each = local.nodes

  ami                    = local.node_ami[each.key]
  instance_type          = each.value.instance_type
  subnet_id              = var.public_subnet_ids[each.value.subnet_index]
  vpc_security_group_ids = [var.security_group_id]
  iam_instance_profile   = var.iam_instance_profile_name
  key_name               = var.ssh_key_name

  root_block_device {
    volume_size = var.root_volume_size_gb
    volume_type = "gp3"
  }

  # OS-level kubeadm prerequisites only (containerd, kubelet/kubeadm/kubectl
  # installed but not run) — `kubeadm init`/`join` is a deliberate Phase 2
  # step, not something this Terraform apply does (SPEC.md §9).
  user_data = templatefile("${path.module}/templates/node-init.sh.tpl", {
    hostname          = "${var.project}-${each.key}"
    k8s_minor_version = var.k8s_minor_version
  })
  user_data_replace_on_change = true

  # The two live nodes predate a node-init.sh.tpl fix (conntrack/ebtables/socat,
  # kubeadm preflight deps — SPEC.md item 8) and were patched by hand instead of
  # via this user_data, so their real user_data attribute permanently differs
  # from what this template now renders. Without this, user_data_replace_on_change
  # pulls that dormant diff into ANY plan touching this resource (even
  # unrelated changes to other nodes/attributes) and proposes replacing BOTH
  # live nodes, tearing down the running kubeadm cluster. The packages the
  # fixed template installs are already present on both boxes by hand, so
  # there's nothing left to reconcile — ignore user_data here rather than
  # let stale bookkeeping threaten a live, single-control-plane cluster with
  # no cert/etcd backup. A real node rebuild (matching user_data for real) is
  # deliberately deferred to the Phase 3 HA milestone (SPEC.md §9), not done
  # incidentally via an unrelated apply.
  #
  # `ami` is ignored for the same reason, and it was a live hazard rather than
  # a theoretical one: the data sources above are `most_recent = true`, so
  # every time Canonical publishes a new Ubuntu image the resolved AMI changes,
  # and `ami` is ForceNew on aws_instance. Both live nodes were running
  # ami-0ac74609c6396bed3 while the lookup had already moved on to a newer
  # build, meaning any apply — including this one — proposed destroying and
  # recreating the entire running cluster as an incidental side effect of
  # Canonical's release schedule. Ignoring it means a node's image is fixed at
  # the moment it is created: new nodes (the arm64 worker) still get the
  # current AMI, because ignore_changes governs updates, not creation, while
  # existing nodes are only ever replaced deliberately — via `-replace` or by
  # removing their entry from var.worker_nodes.
  lifecycle {
    ignore_changes = [ami, user_data]
  }

  tags = {
    Name = "${var.project}-${each.key}"
    Role = each.value.role
  }
}

# Stable public IP for DNS (pugetscope.com) to point at. Attached to the
# control-plane node specifically, but functionally it doesn't matter which
# node holds it — the ingress-nginx Service is a NodePort, and kube-proxy
# forwards traffic hitting *any* node's NodePort to the right pod cluster-wide
# regardless of which node it's actually running on. An EIP also solves the
# "public IP changes on stop/start" problem for whichever instance holds it.
resource "aws_eip" "ingress" {
  domain   = "vpc"
  instance = aws_instance.node["control-plane-1"].id

  tags = {
    Name = "${var.project}-ingress-eip"
  }
}
