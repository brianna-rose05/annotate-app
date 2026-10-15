resource "aws_dynamodb_table" "documents" {
  name         = "${local.project}-documents"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "docId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "docId"
    type = "S"
  }
}