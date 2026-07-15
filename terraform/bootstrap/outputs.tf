output "state_bucket_name" {
  description = "Paste this into terraform/main.tf's backend \"s3\" block (bucket = ...)."
  value       = aws_s3_bucket.terraform_state.id
}
