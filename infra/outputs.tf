output "bucket_name" {
  value = aws_s3_bucket.frontend.id
}

output "site_url" {
  value = "https://${aws_cloudfront_distribution.frontend.domain_name}"
}

output "distribution_id" {
  value = aws_cloudfront_distribution.frontend.id
}

output "github_role_arn" {
  value = aws_iam_role.github_deploy.arn
}