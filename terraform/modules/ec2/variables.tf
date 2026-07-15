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

variable "worker_count" {
  type    = number
  default = 1
}

variable "control_plane_instance_type" {
  description = "kubeadm requires >= 2 vCPU / 2GB RAM for control-plane nodes."
  type        = string
  default     = "t3.medium"
}

variable "worker_instance_type" {
  type    = string
  default = "t3.small"
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
