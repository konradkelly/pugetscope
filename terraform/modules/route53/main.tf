# Hosted zone for pugetscope.com. Hostinger stays the registrar (domain
# purchase); this zone becomes authoritative for DNS once Hostinger's
# nameserver records are pointed at the 4 name_servers output below — a
# manual one-time step at Hostinger, since that account isn't something
# Terraform can reach into.
resource "aws_route53_zone" "main" {
  name = var.domain_name

  tags = {
    Name = "${var.project}-zone"
  }
}

resource "aws_route53_record" "apex" {
  zone_id = aws_route53_zone.main.zone_id
  name    = var.domain_name
  type    = "A"
  ttl     = 300
  records = [var.ingress_ip]
}

# Self-hosted Umami analytics dashboard/collector — same Elastic IP, ingress-nginx
# host-routes it to the umami Service (k8s/base/ingress.yaml, pugetscope-analytics).
resource "aws_route53_record" "analytics" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "analytics.${var.domain_name}"
  type    = "A"
  ttl     = 300
  records = [var.ingress_ip]
}
