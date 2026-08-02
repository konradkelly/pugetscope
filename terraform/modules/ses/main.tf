# SES domain identity for pugetscope.com — lets the app send
# `From: ...@pugetscope.com` mail (password-reset emails, api/src/email/
# sendPasswordResetEmail.ts) once verified via the DNS records the route53
# module creates from this module's outputs. No custom MAIL FROM domain —
# SES's shared subdomain works fine without one; domain identity + DKIM is
# the only hard requirement to send from this domain.
resource "aws_ses_domain_identity" "main" {
  domain = var.domain_name
}

resource "aws_ses_domain_dkim" "main" {
  domain = aws_ses_domain_identity.main.domain
}
