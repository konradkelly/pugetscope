variable "project" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "admin_cidrs" {
  description = "CIDR blocks allowed to reach SSH (22) and the K8s API (6443). Empty list disables both rules entirely (use SSM Session Manager instead)."
  type        = list(string)
  default     = []
}
