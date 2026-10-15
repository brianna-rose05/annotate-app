# 1. Zip the backend/hello folder
data "archive_file" "hello" {
  type        = "zip"
  source_dir  = "${path.module}/../backend/hello"
  output_path = "${path.module}/build/hello.zip"
}

data "archive_file" "documents" {
  type        = "zip"
  source_dir  = "${path.module}/../backend/documents"
  output_path = "${path.module}/build/documents.zip"
}


# 2a. WHO can use this role: the Lambda service
data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# What the Lambda can do in DynamoDB: save and list, in this table only
data "aws_iam_policy_document" "lambda_dynamodb" {
  statement {
    actions   = ["dynamodb:PutItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.documents.arn]
  }
}

# Attach it to the Lambda's role
resource "aws_iam_role_policy" "lambda_dynamodb" {
  name   = "dynamodb-access"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_dynamodb.json
}

# 2b. The role
resource "aws_iam_role" "lambda" {
  name               = "${local.project}-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

# 2c. Permission to write logs (an AWS-provided policy)
resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# 3. The function
resource "aws_lambda_function" "hello" {
  function_name    = "${local.project}-hello"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.hello.output_path
  source_code_hash = data.archive_file.hello.output_base64sha256
}

resource "aws_lambda_function" "documents" {
  function_name    = "${local.project}-documents"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.documents.output_path
  source_code_hash = data.archive_file.documents.output_base64sha256

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.documents.name
    }
  }
}