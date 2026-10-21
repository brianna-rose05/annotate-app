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

resource "aws_dynamodb_table" "annotations" {
  name         = "${local.project}-annotations"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "docId"
  range_key    = "annotationId"

  attribute {
    name = "docId"
    type = "S"
  }

  attribute {
    name = "annotationId"
    type = "S"
  }
}

resource "aws_dynamodb_table" "collections" {
  name         = "${local.project}-collections"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "collectionId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "collectionId"
    type = "S"
  }
}

# Which highlights are in which collection: one row per (collection, highlight) pair
resource "aws_dynamodb_table" "collection_items" {
  name         = "${local.project}-collection-items"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "collectionKey"
  range_key    = "annotationId"

  attribute {
    name = "collectionKey"
    type = "S"
  }

  attribute {
    name = "annotationId"
    type = "S"
  }
}