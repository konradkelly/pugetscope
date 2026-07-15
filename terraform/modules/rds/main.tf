resource "aws_db_subnet_group" "postgres" {
  name_prefix = "${var.project}-postgres-"
  subnet_ids  = var.private_subnet_ids

  tags = {
    Name = "${var.project}-postgres"
  }
}

resource "random_password" "master" {
  length  = 32
  special = false # avoid characters that need extra escaping in connection strings / K8s secrets
}

resource "aws_secretsmanager_secret" "postgres" {
  name                    = "${var.project}/rds/postgres"
  recovery_window_in_days = 0 # portfolio project: allow immediate re-creation on `terraform destroy` + re-apply

  tags = {
    Name = "${var.project}-postgres-credentials"
  }
}

resource "aws_secretsmanager_secret_version" "postgres" {
  secret_id = aws_secretsmanager_secret.postgres.id
  secret_string = jsonencode({
    username = var.master_username
    password = random_password.master.result
    engine   = "postgres"
    host     = aws_db_instance.postgres.address
    port     = aws_db_instance.postgres.port
    dbname   = var.database_name
  })
}

resource "aws_db_instance" "postgres" {
  identifier     = "${var.project}-postgres"
  engine         = "postgres"
  engine_version = var.engine_version

  instance_class        = var.instance_class
  allocated_storage     = var.allocated_storage_gb
  storage_type          = "gp3"
  max_allocated_storage = 0 # no storage autoscaling — keeps cost predictable for a portfolio workload

  db_name  = var.database_name
  username = var.master_username
  password = random_password.master.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.postgres.name
  vpc_security_group_ids = [var.security_group_id]
  publicly_accessible    = false
  multi_az               = false # single-AZ: same cost-vs-HA tradeoff as the single control-plane K8s node (SPEC.md §9)

  # PostGIS is on RDS Postgres's built-in extension allowlist — no custom
  # parameter group needed. Run `CREATE EXTENSION IF NOT EXISTS postgis;`
  # once connected (see terraform/README.md); Terraform can't run SQL.

  backup_retention_period    = var.backup_retention_days
  auto_minor_version_upgrade = true
  skip_final_snapshot        = true # portfolio project — final snapshots would just accumulate cost after `terraform destroy`
  deletion_protection        = false

  tags = {
    Name = "${var.project}-postgres"
  }
}
