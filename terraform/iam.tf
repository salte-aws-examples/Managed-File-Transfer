# Lambda execution role — minimal permissions (CloudWatch Logs + Secrets
# Manager read on the externally-provisioned Entra config secret). No S3
# access. Cannot assume other roles.
resource "aws_iam_role" "lambda_exec" {
  provider = aws.active
  name     = "${var.prefix}-mft-lambda-exec"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "lambda_vpc_execution" {
  provider   = aws.active
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "lambda_exec" {
  provider = aws.active
  name     = "${var.prefix}-mft-lambda-exec"
  role     = aws_iam_role.lambda_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = data.aws_secretsmanager_secret.entra_config.arn
      }
    ]
  })
}

# Transfer Family Lambda invocation permission — when identity_provider_type is
# AWS_LAMBDA, Transfer Family invokes the Lambda directly (not via an IAM role
# it assumes). Permission is granted through a Lambda resource-based policy
# rather than an invocation_role on the server. source_arn scopes the grant to
# only this specific Transfer Family server.
#
# Lives in iam.tf (and not lambda.tf) because the user's lambda.tf is the home
# of the Lambda *function* configuration; this resource is the access-control
# counterpart. Either location is defensible — relocate if your team prefers.
resource "aws_lambda_permission" "transfer_invoke_auth" {
  provider      = aws.active
  statement_id  = "AllowTransferFamilyInvocation"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.auth.function_name
  principal     = "transfer.amazonaws.com"
  source_arn    = aws_transfer_server.mft.arn
}

resource "aws_iam_role" "transfer_logging" {
  provider = aws.active
  name     = "${var.prefix}-mft-logging"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "transfer.amazonaws.com" }
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "transfer_logging" {
  provider   = aws.active
  role       = aws_iam_role.transfer_logging.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSTransferLoggingAccess"
}

# S3 replication role — needs KMS permissions for both source and destination keys
resource "aws_iam_role" "replication" {
  provider = aws.active
  name     = "${var.prefix}-mft-replication"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "s3.amazonaws.com" }
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy" "replication" {
  provider = aws.active
  name     = "${var.prefix}-mft-replication"
  role     = aws_iam_role.replication.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetReplicationConfiguration", "s3:ListBucket"]
        Resource = "arn:aws:s3:::${local.source_bucket_name}"
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObjectVersionForReplication",
          "s3:GetObjectVersionAcl",
          "s3:GetObjectVersionTagging"
        ]
        Resource = "arn:aws:s3:::${local.source_bucket_name}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"]
        Resource = "arn:aws:s3:::${local.replica_bucket_name}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = local.default_key_active_arn
      },
      {
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = local.default_key_passive_arn
      },
    ]
  })
}
