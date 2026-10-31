# 1. The user pool: Cognito's list of users
resource "aws_cognito_user_pool" "main" {
  name = "${local.project}-users"

  username_attributes      = ["email"] # people sign in with their email
  auto_verified_attributes = ["email"] # Cognito emails a code to confirm it's really theirs

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = false
  }

  # "Forgot password" sends a code to their verified email
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
}

# 2. The sign-in page's address (must be unique across all of AWS, hence the random ending)
resource "random_string" "auth_domain" {
  length  = 6
  special = false
  upper   = false
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = "${local.project}-${random_string.auth_domain.result}"
  user_pool_id = aws_cognito_user_pool.main.id
  managed_login_version = 2
}

# Look of the sign-in page (starts with Cognito's clean defaults)
resource "aws_cognito_managed_login_branding" "web" {
  user_pool_id                = aws_cognito_user_pool.main.id
  client_id                   = aws_cognito_user_pool_client.web.id
  use_cognito_provided_values = true

  # Colors and logo are set in the AWS console's visual editor, so Terraform shouldn't undo them
  lifecycle {
    ignore_changes = [settings, asset, use_cognito_provided_values]
  }
}

# 3. The app client: registers your website with the user pool
locals {
  # Where Cognito may send people back to after signing in or out
  app_urls = [
    "http://localhost:5173/",
    "https://${aws_cloudfront_distribution.frontend.domain_name}/",
  ]
}

resource "aws_cognito_user_pool_client" "web" {
  name         = "${local.project}-web"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false # browser apps can't keep a secret, so they use PKCE instead

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"] # the secure "authorization code" flow
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]

  callback_urls = local.app_urls
  logout_urls   = local.app_urls

  explicit_auth_flows           = ["ALLOW_REFRESH_TOKEN_AUTH"] # stay signed in without re-entering a password
  prevent_user_existence_errors = "ENABLED"                    # don't reveal which emails have accounts
}

# Values the frontend needs
output "cognito_authority" {
  value = "https://cognito-idp.us-east-1.amazonaws.com/${aws_cognito_user_pool.main.id}"
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "cognito_domain" {
  value = "https://${aws_cognito_user_pool_domain.main.domain}.auth.us-east-1.amazoncognito.com"
}