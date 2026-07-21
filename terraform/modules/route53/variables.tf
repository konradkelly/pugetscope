variable "project" {
  type = string
}

variable "domain_name" {
  type = string
}

variable "ingress_ip" {
  description = "Elastic IP the apex A record should point at (terraform/modules/ec2's ingress_public_ip output)."
  type        = string
}

variable "google_site_verification" {
  description = "Token from Search Console's 'google-site-verification=...' TXT record challenge. Null skips creating the record."
  type        = string
  default     = null
}
