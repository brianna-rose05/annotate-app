output "bucket_name" {
  value = aws_s3_bucket.frontend.id
}

output "site_url" {
  value = "https://${aws_cloudfront_distribution.frontend.domain_name}"
}