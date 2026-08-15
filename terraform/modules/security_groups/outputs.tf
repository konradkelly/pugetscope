output "k8s_nodes_sg_id" {
  value = aws_security_group.k8s_nodes.id
}

output "rds_sg_id" {
  value = aws_security_group.rds.id
}
