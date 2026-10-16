# Generate a long random secret
resource "random_password" "fetcher_secret" {
  length  = 32
  special = false # letters and numbers only, so it's safe in HTTP headers
}

# Store it encrypted in Parameter Store
resource "aws_ssm_parameter" "fetcher_secret" {
  name  = "/${local.project}/fetcher-secret"
  type  = "SecureString"
  value = random_password.fetcher_secret.result
}

# The role
resource "aws_iam_role" "fetcher" {
  name               = "${local.project}-fetcher"
  assume_role_policy = data.aws_iam_policy_document.ec2_trust.json
}

# 1. Pull images from ECR (AWS-managed, read-only)
resource "aws_iam_role_policy_attachment" "fetcher_ecr" {
  role       = aws_iam_role.fetcher.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# 3. Session Manager access (AWS-managed)
resource "aws_iam_role_policy_attachment" "fetcher_ssm" {
  role       = aws_iam_role.fetcher.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# 2. Read ONLY the fetcher secret
data "aws_iam_policy_document" "fetcher_secret" {
  statement {
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.fetcher_secret.arn]
  }
}

resource "aws_iam_role_policy" "fetcher_secret" {
  name   = "read-fetcher-secret"
  role   = aws_iam_role.fetcher.id
  policy = data.aws_iam_policy_document.fetcher_secret.json
}

# The wrapper EC2 uses to attach the role
resource "aws_iam_instance_profile" "fetcher" {
  name = "${local.project}-fetcher"
  role = aws_iam_role.fetcher.name
}

# Your account's default network (every AWS account comes with one)
data "aws_vpc" "default" {
  default = true
}

resource "aws_security_group" "fetcher" {
  name        = "${local.project}-fetcher"
  description = "Fetcher: port 3000 in, everything out"
  vpc_id      = data.aws_vpc.default.id
}

# Inbound: only port 3000
resource "aws_vpc_security_group_ingress_rule" "fetcher_http" {
  security_group_id = aws_security_group.fetcher.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 3000
  to_port           = 3000
  ip_protocol       = "tcp"
}

# Outbound: allow everything
resource "aws_vpc_security_group_egress_rule" "fetcher_all" {
  security_group_id = aws_security_group.fetcher.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1" # all protocols
}
# Look up the latest Amazon Linux 2023 image (AWS publishes its ID here)
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_instance" "fetcher" {
  count = var.fetcher_enabled ? 1 : 0

  ami                    = data.aws_ssm_parameter.al2023.value
  instance_type          = "t3.micro"
  iam_instance_profile   = aws_iam_instance_profile.fetcher.name
  vpc_security_group_ids = [aws_security_group.fetcher.id]

  user_data = templatefile("${path.module}/fetcher-init.sh.tftpl", {
    secret_name = aws_ssm_parameter.fetcher_secret.name
    registry    = split("/", aws_ecr_repository.fetcher.repository_url)[0]
    image       = "${aws_ecr_repository.fetcher.repository_url}:latest"
  })
  user_data_replace_on_change = true

  # Require the newer, more secure way of reading server info (IMDSv2)
  metadata_options {
    http_tokens = "required"
  }

  # Don't rebuild the server every time AWS releases a new Linux version
  lifecycle {
    ignore_changes = [ami]
  }

  tags = {
    Name = "${local.project}-fetcher"
  }
}