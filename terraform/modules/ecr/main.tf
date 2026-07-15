resource "aws_ecr_repository" "service" {
  for_each = toset(var.repository_names)

  name = "${var.project}/${each.value}"
  # MUTABLE: k8s/push-ecr.sh and the local k3d workflow both push a floating
  # :latest-style tag on every build (ec2-latest / latest respectively), the
  # same pattern already used for the local registry — not versioned by git
  # SHA. Immutable tags would break re-running the push script.
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name    = "${var.project}-${each.value}"
    Service = each.value
  }
}

# Keep storage/cost bounded: expire untagged images quickly, keep only the
# most recent tagged images per repo.
resource "aws_ecr_lifecycle_policy" "service" {
  for_each   = aws_ecr_repository.service
  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 3 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 3
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep only the last ${var.tagged_image_retention_count} tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = var.tagged_image_retention_count
        }
        action = { type = "expire" }
      }
    ]
  })
}
