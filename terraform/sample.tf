# =============================================================================
# SAMPLE RESOURCES — Remove this file entirely in Phase 2 when carrier and
# partner onboarding Terraform modules are built.
# =============================================================================

################################################################################
# Sample partner session role
################################################################################
resource "aws_iam_role" "sample_partner_session" {
  count    = var.dr_mode ? 0 : 1
  provider = aws.active
  name     = "mft-sample-carrier.sample-partner.sample-transfer.np"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "transfer.amazonaws.com" }
    }]
  })

  tags = merge(local.common_tags, { Name = "mft-sample-carrier.sample-partner.sample-transfer.np" })
}

resource "aws_iam_role_policy" "sample_partner_session" {
  count    = var.dr_mode ? 0 : 1
  provider = aws.active
  name     = "mft-sample-carrier.sample-partner.sample-transfer.np"
  role     = aws_iam_role.sample_partner_session[0].id

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
              "non-production/sample-carrier/sample-partner/sample-transfer/*"
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
          "arn:aws:s3:::${local.s3_primary_bucket_name}/non-production/sample-carrier/sample-partner/sample-transfer/*",
          "arn:aws:s3:::${local.s3_dr_bucket_name}/non-production/sample-carrier/sample-partner/sample-transfer/*"
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

