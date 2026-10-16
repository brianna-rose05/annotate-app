resource "aws_s3_bucket_policy" "frontend" {
  bucket     = aws_s3_bucket.frontend.id
  policy     = data.aws_iam_policy_document.frontend.json
  depends_on = [aws_s3_bucket_public_access_block.frontend]
}

resource "aws_s3_bucket" "frontend" {
  bucket_prefix = "${local.project}-frontend-"
}

resource "aws_s3_bucket" "content" {
  bucket_prefix = "${local.project}-content-"

}
resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "content" {
  bucket = aws_s3_bucket.content.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}


data "aws_iam_policy_document" "frontend" {
  statement {
    actions   = ["s3:GetObject"]                    # "Action": read files only
    resources = ["${aws_s3_bucket.frontend.arn}/*"] # "Resource": every file in my bucket

    principals { # "Principal": who
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition { # "Condition": but only MY distribution
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.frontend.arn]
    }
  }
}