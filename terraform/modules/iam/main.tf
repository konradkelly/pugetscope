data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

# ---------------------------------------------------------------------------
# EC2 instance role: attached to every K8s node. Grants ECR pull (image
# pulls from the cluster), SSM (Session Manager access without opening SSH
# to the world), and read access to the app's own secrets.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "ec2_node" {
  name_prefix = "${var.project}-ec2-node-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    Name = "${var.project}-ec2-node"
  }
}

resource "aws_iam_role_policy_attachment" "ecr_read" {
  role       = aws_iam_role.ec2_node.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.ec2_node.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "secrets_read" {
  name   = "${var.project}-secrets-read"
  role   = aws_iam_role.ec2_node.id
  policy = data.aws_iam_policy_document.secrets_read.json
}

data "aws_iam_policy_document" "secrets_read" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = var.readable_secret_arns
  }
}

resource "aws_iam_instance_profile" "ec2_node" {
  name_prefix = "${var.project}-ec2-node-"
  role        = aws_iam_role.ec2_node.name
}

# ---------------------------------------------------------------------------
# GitHub Actions OIDC: lets the repo's workflows assume an AWS role without
# a long-lived access key, scoped to `git push`-triggered runs on this repo.
#
# The OIDC *provider* itself is an account-wide singleton (one per issuer
# URL) — this account already has one (created by another project), so this
# module looks it up rather than creating a second one, and only owns its
# own role/policy trusting it.
# ---------------------------------------------------------------------------

data "aws_iam_openid_connect_provider" "github_actions" {
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_role" "github_actions" {
  name_prefix = "${var.project}-github-actions-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github_actions.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:*"
        }
      }
    }]
  })

  tags = {
    Name = "${var.project}-github-actions"
  }
}

# Scoped to the AWS services this project actually touches (EC2/VPC, RDS,
# ElastiCache, ECR, the state bucket, and IAM resources this project itself
# creates) rather than account-wide admin — CI can run `terraform apply` and
# push images, but not touch unrelated account resources.
resource "aws_iam_role_policy" "github_actions" {
  name   = "${var.project}-terraform-and-ecr"
  role   = aws_iam_role.github_actions.id
  policy = data.aws_iam_policy_document.github_actions.json
}

data "aws_iam_policy_document" "github_actions" {
  statement {
    sid    = "TerraformManagedServices"
    effect = "Allow"
    actions = [
      "ec2:*",
      "rds:*",
      "elasticache:*",
      "ecr:*",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "IamForProjectResources"
    effect = "Allow"
    actions = [
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:GetInstanceProfile",
      "iam:GetOpenIDConnectProvider",
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:CreateInstanceProfile",
      "iam:DeleteInstanceProfile",
      "iam:AddRoleToInstanceProfile",
      "iam:RemoveRoleFromInstanceProfile",
      "iam:PassRole",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${var.project}-*",
      "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:instance-profile/${var.project}-*",
    ]
  }

  statement {
    sid       = "SecretsForApp"
    effect    = "Allow"
    actions   = ["secretsmanager:*"]
    resources = ["arn:${data.aws_partition.current.partition}:secretsmanager:*:${data.aws_caller_identity.current.account_id}:secret:${var.project}/*"]
  }

  statement {
    sid       = "TerraformStateBucket"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
    resources = [var.state_bucket_arn, "${var.state_bucket_arn}/*"]
  }
}
