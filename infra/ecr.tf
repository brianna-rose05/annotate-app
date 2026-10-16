resource "aws_ecr_repository" "fetcher" {
  name         = "${local.project}-fetcher"
  force_delete = true # lets terraform destroy delete it even with images inside

  image_scanning_configuration {
    scan_on_push = true # AWS checks each image for known security vulnerabilities
  }
}

# Only keep the 5 newest images, so old ones don't pile up and cost money
resource "aws_ecr_lifecycle_policy" "fetcher" {
  repository = aws_ecr_repository.fetcher.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep only the 5 most recent images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = { type = "expire" }
    }]
  })
}