output "endpoint" {
  value = aws_db_instance.postgres.address
}

output "port" {
  value = aws_db_instance.postgres.port
}

output "database_name" {
  value = aws_db_instance.postgres.db_name
}

output "secret_arn" {
  description = "Secrets Manager ARN holding username/password/host/port/dbname."
  value       = aws_secretsmanager_secret.postgres.arn
}
