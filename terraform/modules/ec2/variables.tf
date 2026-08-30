variable "project" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "security_group_id" {
  type = string
}

variable "iam_instance_profile_name" {
  type = string
}

variable "ssh_key_name" {
  description = "Existing EC2 key pair name for SSH access. Leave null to rely on SSM Session Manager only (see security_groups module's admin_cidrs for opening SSH instead)."
  type        = string
  default     = null
}

variable "control_plane_count" {
  type    = number
  default = 1
}

variable "control_plane_instance_type" {
  description = "kubeadm requires >= 2 vCPU / 2GB RAM for control-plane nodes."
  type        = string
  default     = "t3.medium"
}

variable "worker_nodes" {
  description = <<-EOT
    Worker nodes keyed by node name — the name becomes the instance's hostname
    and its address in Terraform state, so entries can be added and removed
    individually. Architecture is inferred from instance_type (a Graviton
    family such as t4g.small selects the arm64 AMI), so moving a worker between
    architectures is a one-line change here plus a `-replace` or an
    add-drain-remove cycle; see k8s/README.md "Migrating a worker to Graviton".

    subnet_index picks the AZ from var.public_subnet_ids. It defaults to 1
    because the control plane takes index 0, so the default single worker lands
    in the other AZ. Never change it for a node that already exists — subnet_id
    is ForceNew, so an edit here replaces a running node.
  EOT
  type = map(object({
    instance_type = string
    subnet_index  = optional(number, 1)
  }))
  default = {
    "worker-1" = { instance_type = "t3.small" }
  }
}

variable "root_volume_size_gb" {
  type    = number
  default = 20
}

variable "k8s_minor_version" {
  description = "Kubernetes minor version line (pkgs.k8s.io repo, e.g. \"1.31\") for kubelet/kubeadm/kubectl installed by node-init.sh.tpl."
  type        = string
  default     = "1.31"
}
