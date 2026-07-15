output "node_public_ips" {
  description = "Map of node name -> public IP."
  value       = { for name, inst in aws_instance.node : name => inst.public_ip }
}

output "node_instance_ids" {
  description = "Map of node name -> instance ID (for `aws ssm start-session --target ...`)."
  value       = { for name, inst in aws_instance.node : name => inst.id }
}

output "control_plane_names" {
  value = [for name, node in local.nodes : name if node.role == "control-plane"]
}

output "worker_names" {
  value = [for name, node in local.nodes : name if node.role == "worker"]
}

output "ingress_public_ip" {
  description = "Stable Elastic IP — point DNS at this, not a node's own (ephemeral) public_ip."
  value       = aws_eip.ingress.public_ip
}
