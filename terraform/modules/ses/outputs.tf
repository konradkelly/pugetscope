output "identity_arn" {
  value = aws_ses_domain_identity.main.arn
}

output "verification_token" {
  description = "Value for the _amazonses.<domain> TXT record (route53 module)."
  value       = aws_ses_domain_identity.main.verification_token
}

output "dkim_tokens" {
  description = "3 tokens, each backing a <token>._domainkey.<domain> CNAME record (route53 module)."
  value       = aws_ses_domain_dkim.main.dkim_tokens
}
