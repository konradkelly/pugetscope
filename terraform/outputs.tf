output "vpc_id" {
  value = module.vpc.vpc_id
}

output "ecr_repository_urls" {
  value = module.ecr.repository_urls
}

output "rds_endpoint" {
  value = module.rds.endpoint
}

output "rds_secret_arn" {
  description = "aws secretsmanager get-secret-value --secret-id <this> to retrieve Postgres credentials."
  value       = module.rds.secret_arn
}

output "redis_endpoint" {
  value = module.elasticache.endpoint
}

output "k8s_node_public_ips" {
  value = module.ec2.node_public_ips
}

output "k8s_node_instance_ids" {
  description = "For `aws ssm start-session --target <id>` (no SSH key needed)."
  value       = module.ec2.node_instance_ids
}

output "k8s_control_plane_names" {
  value = module.ec2.control_plane_names
}

output "k8s_worker_names" {
  value = module.ec2.worker_names
}

output "github_actions_role_arn" {
  value = module.iam.github_actions_role_arn
}

output "ingress_public_ip" {
  description = "Elastic IP — stable across node stop/start, unlike a node's own public_ip."
  value       = module.ec2.ingress_public_ip
}

output "route53_name_servers" {
  description = "Set these as pugetscope.com's nameservers at Hostinger (registrar) to delegate DNS to this Route 53 zone."
  value       = module.route53.name_servers
}
