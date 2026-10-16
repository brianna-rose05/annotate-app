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

output "api_url" {
  value = aws_apigatewayv2_stage.default.invoke_url
}

output "fetcher_repo_url" {
    value = aws_ecr_repository.fetcher.repository_url
  }

output "fetcher_url" {
  value = var.fetcher_enabled ? "http://${aws_instance.fetcher[0].public_ip}:3000" : null
}