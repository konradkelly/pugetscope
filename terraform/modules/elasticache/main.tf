resource "aws_elasticache_subnet_group" "redis" {
  name       = "${var.project}-redis"
  subnet_ids = var.private_subnet_ids
}

# Single node, no AUTH/TLS: Redis here only ever holds latest aircraft
# positions and pub/sub traffic (SPEC.md §7) — not secrets — so the
# client-side TLS complexity isn't worth it for v1. Revisit if session/
# rate-limit data (§6) ends up sharing this cache without its own auth layer.
resource "aws_elasticache_cluster" "redis" {
  cluster_id      = "${var.project}-redis"
  engine          = "redis"
  engine_version  = var.engine_version
  node_type       = var.node_type
  num_cache_nodes = 1
  port            = 6379

  subnet_group_name  = aws_elasticache_subnet_group.redis.name
  security_group_ids = [var.security_group_id]

  apply_immediately = true

  tags = {
    Name = "${var.project}-redis"
  }
}
