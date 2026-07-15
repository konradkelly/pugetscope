output "repository_urls" {
  description = "Map of service name -> full ECR repository URL (for `docker push` / K8s manifest image refs)."
  value       = { for name, repo in aws_ecr_repository.service : name => repo.repository_url }
}
