variable "project" {
  type = string
}

variable "github_repo" {
  description = "GitHub \"owner/repo\" allowed to assume the CI role via OIDC."
  type        = string
}

variable "state_bucket_arn" {
  description = "ARN of the S3 bucket holding Terraform state (from bootstrap), so CI can run terraform plan/apply."
  type        = string
}

variable "readable_secret_arns" {
  description = "Secrets Manager ARNs the EC2 node role may read (e.g. RDS credentials)."
  type        = list(string)
  default     = []
}
