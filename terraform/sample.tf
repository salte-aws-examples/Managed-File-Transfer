# =============================================================================
# SAMPLE RESOURCES — Remove this file entirely in Phase 2 when carrier and
# partner onboarding Terraform modules are built.
# =============================================================================

locals {
  sample_timestamp = "2024-01-01T00:00:00Z"
}

resource "aws_dynamodb_table_item" "sample_carrier" {
  count      = var.dr_mode ? 0 : 1
  provider   = aws.active
  table_name = aws_dynamodb_table.carriers[0].name
  hash_key   = "carrierId"

  item = jsonencode({
    carrierId = { S = "sample-carrier" }
    name      = { S = "Sample Carrier" }
    status    = { S = "active" }
    createdAt = { S = local.sample_timestamp }
    updatedAt = { S = local.sample_timestamp }
  })
}

resource "aws_dynamodb_table_item" "sample_partner" {
  count      = var.dr_mode ? 0 : 1
  provider   = aws.active
  table_name = aws_dynamodb_table.partners[0].name
  hash_key   = "partnerId"

  item = jsonencode({
    partnerId           = { S = "sample-partner" }
    name                = { S = "Sample Partner" }
    status              = { S = "active" }
    allowedSourceCidrs  = { S = jsonencode(["0.0.0.0/0"]) }
    createdAt           = { S = local.sample_timestamp }
    updatedAt           = { S = local.sample_timestamp }
  })
}

resource "aws_dynamodb_table_item" "sample_transfer_type_1" {
  count      = var.dr_mode ? 0 : 1
  provider   = aws.active
  table_name = aws_dynamodb_table.transfer_types[0].name
  hash_key   = "transferTypeId"

  item = jsonencode({
    transferTypeId = { S = "sample-transfer-1" }
    name           = { S = "Sample Transfer 1" }
    status         = { S = "active" }
    createdAt      = { S = local.sample_timestamp }
    updatedAt      = { S = local.sample_timestamp }
  })
}

resource "aws_dynamodb_table_item" "sample_transfer_type_2" {
  count      = var.dr_mode ? 0 : 1
  provider   = aws.active
  table_name = aws_dynamodb_table.transfer_types[0].name
  hash_key   = "transferTypeId"

  item = jsonencode({
    transferTypeId = { S = "sample-transfer-2" }
    name           = { S = "Sample Transfer 2" }
    status         = { S = "active" }
    createdAt      = { S = local.sample_timestamp }
    updatedAt      = { S = local.sample_timestamp }
  })
}

resource "aws_dynamodb_table_item" "sample_transfer_type_3" {
  count      = var.dr_mode ? 0 : 1
  provider   = aws.active
  table_name = aws_dynamodb_table.transfer_types[0].name
  hash_key   = "transferTypeId"

  item = jsonencode({
    transferTypeId = { S = "sample-transfer-3" }
    name           = { S = "Sample Transfer 3" }
    status         = { S = "active" }
    createdAt      = { S = local.sample_timestamp }
    updatedAt      = { S = local.sample_timestamp }
  })
}

# Sample users — friendly usernames for smoke testing. The username is only the
# DynamoDB lookup key; role ARN, home directory, and auth config come from the
# record fields, not from the username string.
resource "aws_dynamodb_table_item" "sample_user_ftps_simple" {
  count      = var.dr_mode ? 0 : 1
  provider   = aws.active
  table_name = aws_dynamodb_table.users[0].name
  hash_key   = "username"

  item = jsonencode({
    username       = { S = "sample-ftps-test" }
    carrierId      = { S = "sample-carrier" }
    partnerId      = { S = "sample-partner" }
    transferTypeId = { S = "sample-transfer-1" }
    env            = { S = "np" }
    protocol       = { S = "ftps" }
    clientId       = { S = var.sample_ftps_entra_client_id }
    contactEmail   = { S = "sample-partner@example.com" }
    internalOwner  = { S = "mft-owner@${var.prefix}.com" }
    status         = { S = "active" }
    createdAt      = { S = local.sample_timestamp }
    updatedAt      = { S = local.sample_timestamp }
  })
}

resource "aws_dynamodb_table_item" "sample_user_sftp_ssh_simple" {
  count      = var.dr_mode ? 0 : 1
  provider   = aws.active
  table_name = aws_dynamodb_table.users[0].name
  hash_key   = "username"

  item = jsonencode({
    username       = { S = "sample-sftp-test" }
    carrierId      = { S = "sample-carrier" }
    partnerId      = { S = "sample-partner" }
    transferTypeId = { S = "sample-transfer-2" }
    env            = { S = "np" }
    protocol       = { S = "sftp" }
    publicKey      = { S = var.sample_sftp_ssh_public_key }
    contactEmail   = { S = "sample-partner@example.com" }
    internalOwner  = { S = "mft-owner@${var.prefix}.com" }
    status         = { S = "active" }
    createdAt      = { S = local.sample_timestamp }
    updatedAt      = { S = local.sample_timestamp }
  })
}

resource "aws_dynamodb_table_item" "sample_user_sftp_entra_simple" {
  count      = var.dr_mode ? 0 : 1
  provider   = aws.active
  table_name = aws_dynamodb_table.users[0].name
  hash_key   = "username"

  item = jsonencode({
    username       = { S = "sample-sftp-entra-test" }
    carrierId      = { S = "sample-carrier" }
    partnerId      = { S = "sample-partner" }
    transferTypeId = { S = "sample-transfer-3" }
    env            = { S = "np" }
    protocol       = { S = "sftp" }
    clientId       = { S = var.sample_sftp_entra_client_id }
    contactEmail   = { S = "sample-partner@example.com" }
    internalOwner  = { S = "mft-owner@${var.prefix}.com" }
    status         = { S = "active" }
    createdAt      = { S = local.sample_timestamp }
    updatedAt      = { S = local.sample_timestamp }
  })
}

resource "aws_iam_role" "sample_session_1" {
  count    = var.dr_mode ? 0 : 1
  provider = aws.active
  name     = "mft-sample-carrier.sample-partner.sample-transfer-1.np"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "transfer.amazonaws.com" }
    }]
  })

  tags = merge(local.common_tags, { Name = "mft-sample-carrier.sample-partner.sample-transfer-1.np" })
}

resource "aws_iam_role_policy" "sample_session_1" {
  count    = var.dr_mode ? 0 : 1
  provider = aws.active
  name     = "mft-sample-carrier.sample-partner.sample-transfer-1.np"
  role     = aws_iam_role.sample_session_1[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["s3:ListBucket", "s3:GetBucketLocation"]
        Resource = [
          "arn:aws:s3:::${local.s3_primary_bucket_name}",
          "arn:aws:s3:::${local.s3_dr_bucket_name}"
        ]
        Condition = {
          StringLike = {
            "s3:prefix" = [
              "non-production/sample-carrier/sample-partner/sample-transfer-1/*"
            ]
          }
        }
      },
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:GetObjectVersion",
          "s3:DeleteObjectVersion"
        ]
        Resource = [
          "arn:aws:s3:::${local.s3_primary_bucket_name}/non-production/sample-carrier/sample-partner/sample-transfer-1/*",
          "arn:aws:s3:::${local.s3_dr_bucket_name}/non-production/sample-carrier/sample-partner/sample-transfer-1/*"
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = local.default_key_active_arn
      }
    ]
  })
}

resource "aws_iam_role" "sample_session_2" {
  count    = var.dr_mode ? 0 : 1
  provider = aws.active
  name     = "mft-sample-carrier.sample-partner.sample-transfer-2.np"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "transfer.amazonaws.com" }
    }]
  })

  tags = merge(local.common_tags, { Name = "mft-sample-carrier.sample-partner.sample-transfer-2.np" })
}

resource "aws_iam_role_policy" "sample_session_2" {
  count    = var.dr_mode ? 0 : 1
  provider = aws.active
  name     = "mft-sample-carrier.sample-partner.sample-transfer-2.np"
  role     = aws_iam_role.sample_session_2[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["s3:ListBucket", "s3:GetBucketLocation"]
        Resource = [
          "arn:aws:s3:::${local.s3_primary_bucket_name}",
          "arn:aws:s3:::${local.s3_dr_bucket_name}"
        ]
        Condition = {
          StringLike = {
            "s3:prefix" = [
              "non-production/sample-carrier/sample-partner/sample-transfer-2/*"
            ]
          }
        }
      },
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:GetObjectVersion",
          "s3:DeleteObjectVersion"
        ]
        Resource = [
          "arn:aws:s3:::${local.s3_primary_bucket_name}/non-production/sample-carrier/sample-partner/sample-transfer-2/*",
          "arn:aws:s3:::${local.s3_dr_bucket_name}/non-production/sample-carrier/sample-partner/sample-transfer-2/*"
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = local.default_key_active_arn
      }
    ]
  })
}

resource "aws_iam_role" "sample_session_3" {
  count    = var.dr_mode ? 0 : 1
  provider = aws.active
  name     = "mft-sample-carrier.sample-partner.sample-transfer-3.np"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "transfer.amazonaws.com" }
    }]
  })

  tags = merge(local.common_tags, { Name = "mft-sample-carrier.sample-partner.sample-transfer-3.np" })
}

resource "aws_iam_role_policy" "sample_session_3" {
  count    = var.dr_mode ? 0 : 1
  provider = aws.active
  name     = "mft-sample-carrier.sample-partner.sample-transfer-3.np"
  role     = aws_iam_role.sample_session_3[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["s3:ListBucket", "s3:GetBucketLocation"]
        Resource = [
          "arn:aws:s3:::${local.s3_primary_bucket_name}",
          "arn:aws:s3:::${local.s3_dr_bucket_name}"
        ]
        Condition = {
          StringLike = {
            "s3:prefix" = [
              "non-production/sample-carrier/sample-partner/sample-transfer-3/*"
            ]
          }
        }
      },
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:GetObjectVersion",
          "s3:DeleteObjectVersion"
        ]
        Resource = [
          "arn:aws:s3:::${local.s3_primary_bucket_name}/non-production/sample-carrier/sample-partner/sample-transfer-3/*",
          "arn:aws:s3:::${local.s3_dr_bucket_name}/non-production/sample-carrier/sample-partner/sample-transfer-3/*"
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = local.default_key_active_arn
      }
    ]
  })
}
