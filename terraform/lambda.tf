################################################################################
# Lambda auth broker — Transfer Family identity provider
#
# Transfer Family invokes this Lambda directly for every SFTP and FTPS
# authentication attempt. The Lambda validates partner credentials against
# Entra ID or SSH public key auth, then derives the session IAM role and home
# directory from the DynamoDB user record.
#
# Source: src/main/auth/index.ts — bundled to .build/lambda/auth/index.js via
# npm run build:lambda. Terraform zips .build/lambda/auth on apply.
################################################################################

data "archive_file" "auth_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../.build/lambda/auth"
  output_path = "${path.module}/../.build/lambda/auth.zip"
}

resource "aws_lambda_function" "auth" {
  provider         = aws.active
  function_name    = "${var.prefix}-mft-auth"
  description      = "Transfer Family identity provider — looks up partner in DynamoDB, validates credentials against Entra ID (FTPS) or SSH public key (SFTP), returns session role and home directory"
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  role             = aws_iam_role.lambda_exec.arn
  filename         = data.archive_file.auth_lambda.output_path
  source_code_hash = data.archive_file.auth_lambda.output_base64sha256
  timeout          = 10
  memory_size      = 256

  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      ENTRA_CONFIG_SECRET = local.entra_config_secret
      S3_BUCKET_NAME      = local.source_bucket_name
      USERS_TABLE         = "${var.prefix}-mft-users"
    }
  }

  tags = merge(local.common_tags, { Name = "${var.prefix}-mft-auth" })
}

resource "aws_cloudwatch_log_group" "auth_lambda" {
  provider          = aws.active
  name              = "/aws/lambda/${var.prefix}-mft-auth"
  retention_in_days = 90
  tags              = local.common_tags
}
