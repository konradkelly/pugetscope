variable "project" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "security_group_id" {
  type = string
}

variable "engine_version" {
  type    = string
  default = "16"
}

variable "instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "allocated_storage_gb" {
  type    = number
  default = 20
}

variable "backup_retention_days" {
  type    = number
  default = 1
}

variable "database_name" {
  type    = string
  default = "pugetscope"
}

variable "master_username" {
  type    = string
  default = "pugetscope_admin"
}
