/*
  One-time bootstrap: creates the S3 bucket that holds the *main* Terraform
  state (terraform/). This config's own state stays local (see .gitignore) —
  it can't store its state in the bucket it's creating.

  Usage:
    cd terraform/bootstrap
    terraform init
    terraform apply

  Run once per AWS account. Re-running is safe (idempotent) but should not
  be necessary after the bucket exists.
*/

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

locals {
  # Deterministic (not random) so the root module's backend block — which
  # cannot contain interpolated expressions — can hardcode the same name.
  state_bucket_name = "pugetscope-tfstate-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "terraform_state" {
  bucket = local.state_bucket_name

  # Portfolio project, but state loss is still a real pain — keep the bucket
  # around even if someone runs `terraform destroy` against this config.
  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Project   = "pugetscope"
    Purpose   = "terraform-state"
    ManagedBy = "terraform-bootstrap"
  }
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
