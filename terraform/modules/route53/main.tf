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

# Search Console domain-ownership proof (Settings > Ownership verification > DNS record).
resource "aws_route53_record" "google_site_verification" {
  count   = var.google_site_verification != null ? 1 : 0
  zone_id = aws_route53_zone.main.zone_id
  name    = var.domain_name
  type    = "TXT"
  ttl     = 300
  records = ["google-site-verification=${var.google_site_verification}"]
}

# SES domain identity verification (module.ses) — required for the api
# service to send `From: ...@pugetscope.com` password-reset mail.
#
# Unlike google_site_verification above, this can't use a
# `count = var.x != null ? 1 : 0` guard: that value is a literal string this
# root module either passes or doesn't, known at plan time either way, but
# ses_verification_token is module.ses's computed output — unknown until
# module.ses is first created, so Terraform can't evaluate a count expression
# built from it on that first apply ("Invalid count argument"). Unconditional
# instead; this module now always expects SES to be wired in.
resource "aws_route53_record" "ses_verification" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "_amazonses.${var.domain_name}"
  type    = "TXT"
  ttl     = 300
  records = [var.ses_verification_token]
}

# DKIM signing records — 3 tokens, each its own CNAME (aws_ses_domain_dkim's
# documented record shape). Verification email delivery works with just the
# TXT record above, but without these, outgoing mail isn't DKIM-signed and
# is more likely to land in spam.
#
# count = 3 is a static literal, not `length(var.ses_dkim_tokens)` — same
# "count can't depend on a not-yet-known computed value" problem as above,
# just hitting the whole list's length instead of a single string's
# nullness. AWS SES's "Easy DKIM" always issues exactly 3 CNAME tokens per
# domain (documented AWS behavior), so hardcoding 3 is safe, not a guess.
resource "aws_route53_record" "ses_dkim" {
  count   = 3
  zone_id = aws_route53_zone.main.zone_id
  name    = "${var.ses_dkim_tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 300
  records = ["${var.ses_dkim_tokens[count.index]}.dkim.amazonses.com"]
}
