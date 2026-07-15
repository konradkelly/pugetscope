output "zone_id" {
  value = aws_route53_zone.main.zone_id
}

output "name_servers" {
  description = "Set these as the domain's nameservers at Hostinger (registrar) to delegate DNS to this zone."
  value       = aws_route53_zone.main.name_servers
}
