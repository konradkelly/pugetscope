# S3 bucket ARN for the state bucket created in terraform/bootstrap — needed
# so the github_actions IAM role can be scoped to read/write it.
locals {
  state_bucket_arn = "arn:aws:s3:::pugetscope-tfstate-675901257165"
}

module "vpc" {
  source = "./modules/vpc"

  project              = var.project
  vpc_cidr             = var.vpc_cidr
  public_subnet_cidrs  = var.public_subnet_cidrs
  private_subnet_cidrs = var.private_subnet_cidrs
}

module "security_groups" {
  source = "./modules/security_groups"

  project     = var.project
  vpc_id      = module.vpc.vpc_id
  admin_cidrs = var.admin_cidrs
}

module "ecr" {
  source = "./modules/ecr"

  project          = var.project
  repository_names = var.ecr_repository_names
}

module "rds" {
  source = "./modules/rds"

  project              = var.project
  private_subnet_ids   = module.vpc.private_subnet_ids
  security_group_id    = module.security_groups.rds_sg_id
  instance_class       = var.rds_instance_class
  allocated_storage_gb = var.rds_allocated_storage_gb
}

module "elasticache" {
  source = "./modules/elasticache"

  project            = var.project
  private_subnet_ids = module.vpc.private_subnet_ids
  security_group_id  = module.security_groups.redis_sg_id
  node_type          = var.redis_node_type
}

module "iam" {
  source = "./modules/iam"

  project              = var.project
  github_repo          = var.github_repo
  state_bucket_arn     = local.state_bucket_arn
  readable_secret_arns = [module.rds.secret_arn]
}

module "ec2" {
  source = "./modules/ec2"

  project                     = var.project
  public_subnet_ids           = module.vpc.public_subnet_ids
  security_group_id           = module.security_groups.k8s_nodes_sg_id
  iam_instance_profile_name   = module.iam.ec2_instance_profile_name
  ssh_key_name                = var.ssh_key_name
  control_plane_count         = var.control_plane_count
  worker_count                = var.worker_count
  control_plane_instance_type = var.control_plane_instance_type
  worker_instance_type        = var.worker_instance_type
  k8s_minor_version           = var.k8s_minor_version
}
