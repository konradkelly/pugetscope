variable "project" {
  description = "Project name, used in resource naming/tags."
  type        = string
  default     = "pugetscope"
}

variable "aws_region" {
  type    = string
  default = "us-west-2"
}

variable "github_repo" {
  description = "GitHub \"owner/repo\" allowed to assume the CI role via OIDC."
  type        = string
  default     = "konradkelly/pugetscope"
}

# --- Networking ---

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "public_subnet_cidrs" {
  type    = list(string)
  default = ["10.0.0.0/24", "10.0.1.0/24"]
}

variable "private_subnet_cidrs" {
  type    = list(string)
  default = ["10.0.10.0/24", "10.0.11.0/24"]
}

variable "admin_cidrs" {
  description = "CIDR blocks (e.g. [\"YOUR.IP.ADDR.ESS/32\"]) allowed to reach SSH (22) and the K8s API (6443) on the nodes. Empty by default — use SSM Session Manager instead, or set this in terraform.tfvars for direct access."
  type        = list(string)
  default     = []
}

# --- EC2 / K8s nodes ---

variable "control_plane_count" {
  type    = number
  default = 1
}

variable "worker_count" {
  type    = number
  default = 1
}

variable "control_plane_instance_type" {
  type    = string
  default = "t3.medium"
}

variable "worker_instance_type" {
  type    = string
  default = "t3.small"
}

variable "ssh_key_name" {
  description = "Existing EC2 key pair name. Leave null to rely on SSM Session Manager only."
  type        = string
  default     = null
}

variable "k8s_minor_version" {
  type    = string
  default = "1.31"
}

# --- RDS ---

variable "rds_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "rds_allocated_storage_gb" {
  type    = number
  default = 20
}

# --- ElastiCache ---

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

# --- ECR ---

variable "ecr_repository_names" {
  type    = list(string)
  default = ["frontend", "api", "ingestion", "websocket"]
}
