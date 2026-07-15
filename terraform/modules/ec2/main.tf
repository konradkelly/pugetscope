data "aws_ami" "ubuntu" {
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

locals {
  # One map entry per node, e.g. { "control-plane-1" = {...}, "worker-1" = {...}, "worker-2" = {...} }
  # so nodes are addressable individually in state instead of shifting on count changes.
  nodes = merge(
    { for i in range(var.control_plane_count) : "control-plane-${i + 1}" => {
      role          = "control-plane"
      instance_type = var.control_plane_instance_type
    } },
    { for i in range(var.worker_count) : "worker-${i + 1}" => {
      role          = "worker"
      instance_type = var.worker_instance_type
    } },
  )
}

resource "aws_instance" "node" {
  for_each = local.nodes

  ami                    = data.aws_ami.ubuntu.id
  instance_type          = each.value.instance_type
  subnet_id              = var.public_subnet_ids[index(keys(local.nodes), each.key) % length(var.public_subnet_ids)]
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

  tags = {
    Name = "${var.project}-${each.key}"
    Role = each.value.role
  }
}
