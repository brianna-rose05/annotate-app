locals {
  site_domain = "annotate.briannapischke.com"
}

# Free HTTPS certificate for the custom domain (must be in us-east-1 for CloudFront)
resource "aws_acm_certificate" "site" {
  domain_name       = local.site_domain
  validation_method = "DNS" # prove ownership by adding a DNS record

  lifecycle {
    create_before_destroy = true
  }
}

# The DNS record to add in Porkbun to prove ownership
output "cert_validation_record" {
  value = [for o in aws_acm_certificate.site.domain_validation_options : {
    name  = o.resource_record_name
    type  = o.resource_record_type
    value = o.resource_record_value
  }]
}

# Waits until AWS has seen the Porkbun record and issued the certificate
resource "aws_acm_certificate_validation" "site" {
  certificate_arn = aws_acm_certificate.site.arn
}