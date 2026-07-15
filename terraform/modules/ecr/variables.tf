variable "project" {
  type = string
}

variable "repository_names" {
  description = "Short service names, one ECR repo per entry (e.g. \"api\" -> pugetscope/api)."
  type        = list(string)
}

variable "tagged_image_retention_count" {
  type    = number
  default = 10
}
