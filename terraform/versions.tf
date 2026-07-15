terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Bucket created by terraform/bootstrap (see that dir's outputs). Bucket
  # name is deterministic (project + AWS account ID), not random, precisely
  # so it can be hardcoded here — backend blocks can't contain interpolated
  # expressions or variable references.
  #
  # Uses Terraform 1.10+ native S3 locking (`use_lockfile`) instead of a
  # separate DynamoDB lock table — one fewer resource to manage for a
  # single-developer project.
  backend "s3" {
    bucket       = "pugetscope-tfstate-675901257165"
    key          = "pugetscope/terraform.tfstate"
    region       = "us-west-2"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
    }
  }
}
