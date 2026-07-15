output "endpoint" {
  value = aws_elasticache_cluster.redis.cache_nodes[0].address
}

output "port" {
  value = aws_elasticache_cluster.redis.port
}
