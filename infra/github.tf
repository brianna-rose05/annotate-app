# 1. Trust GitHub as an identity provider
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

# 2a. WHO can use the role: only workflows from my repo's main branch
data "aws_iam_policy_document" "github_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:brianna-rose05/annotate-app:ref:refs/heads/main"]
    }
  }
}

# 2b. The role itself
resource "aws_iam_role" "github_deploy" {
  name               = "${local.project}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_trust.json
}

# 3a. WHAT the role can do
data "aws_iam_policy_document" "github_deploy" {
  # List what's in my bucket (s3 sync needs this)
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.frontend.arn]
  }

  # Upload and delete files in my bucket
  statement {
    actions   = ["s3:PutObject", "s3:DeleteObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.frontend.arn}/*"]
  }

  # Clear MY CloudFront cache
  statement {
    actions   = ["cloudfront:CreateInvalidation"]
    resources = [aws_cloudfront_distribution.frontend.arn]
  }
}

# 3b. Attach those permissions to the role
resource "aws_iam_role_policy" "github_deploy" {
  name   = "deploy-frontend"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}