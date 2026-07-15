output "ec2_instance_profile_name" {
  value = aws_iam_instance_profile.ec2_node.name
}

output "github_actions_role_arn" {
  description = "Set as AWS_ROLE_ARN (or similar) in the GitHub Actions workflow / repo secrets."
  value       = aws_iam_role.github_actions.arn
}
