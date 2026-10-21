# 1. The API
resource "aws_apigatewayv2_api" "main" {
  name          = "${local.project}-api"
  protocol_type = "HTTP"

  # Which websites are allowed to call this API from a browser
  cors_configuration {
    allow_origins = [
      "https://${aws_cloudfront_distribution.frontend.domain_name}",
      "http://localhost:5173",
    ]
        allow_methods = ["GET", "POST", "DELETE", "OPTIONS", "PATCH"]
    allow_headers = ["content-type"]
  }
}

# 2. Connect the API to the Lambda
resource "aws_apigatewayv2_integration" "hello" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.hello.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "documents" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.documents.invoke_arn
  payload_format_version = "2.0"
}

# 3. GET /hello → the Lambda
resource "aws_apigatewayv2_route" "hello" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /hello"
  target    = "integrations/${aws_apigatewayv2_integration.hello.id}"
}

resource "aws_apigatewayv2_route" "documents_get" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /documents"
  target    = "integrations/${aws_apigatewayv2_integration.documents.id}"
}

resource "aws_apigatewayv2_route" "documents_post" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /documents"
  target    = "integrations/${aws_apigatewayv2_integration.documents.id}"
}


# 4. The live version, with spam protection
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = 5  # requests per second on average
    throttling_burst_limit = 10 # short spikes allowed
  }
}

# 5. Allow API Gateway to run the Lambda
resource "aws_lambda_permission" "api" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.hello.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "api_documents" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.documents.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

resource "aws_apigatewayv2_route" "documents_get_one" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /documents/{docId}"
  target    = "integrations/${aws_apigatewayv2_integration.documents.id}"
}

resource "aws_apigatewayv2_route" "annotations_list" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /documents/{docId}/annotations"
  target    = "integrations/${aws_apigatewayv2_integration.documents.id}"
}

resource "aws_apigatewayv2_route" "annotations_create" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /documents/{docId}/annotations"
  target    = "integrations/${aws_apigatewayv2_integration.documents.id}"
}

resource "aws_apigatewayv2_route" "annotations_delete" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "DELETE /documents/{docId}/annotations/{annotationId}"
  target    = "integrations/${aws_apigatewayv2_integration.documents.id}"
}

resource "aws_apigatewayv2_route" "documents_delete" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "DELETE /documents/{docId}"
  target    = "integrations/${aws_apigatewayv2_integration.documents.id}"
}

resource "aws_apigatewayv2_route" "annotations_update" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "PATCH /documents/{docId}/annotations/{annotationId}"
  target    = "integrations/${aws_apigatewayv2_integration.documents.id}"
}

resource "aws_apigatewayv2_route" "collections_list" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /collections"
  target    = "integrations/${aws_apigatewayv2_integration.documents.id}"
}

resource "aws_apigatewayv2_route" "collection_highlights" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /collections/{collectionId}/highlights"
  target    = "integrations/${aws_apigatewayv2_integration.documents.id}"
}