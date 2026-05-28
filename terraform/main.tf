################################################################################
# Security group — inbound on 22 (SFTP), 21 + 1024-65535 (FTPS), 443 (AS2)
################################################################################
resource "aws_security_group" "transfer" {
  provider    = aws.active
  name        = "${var.prefix}-mft-transfer"
  description = "Controls inbound access to the Transfer Family VPC endpoint"
  vpc_id      = data.aws_vpc.this.id

  ingress {
    description = "SFTP"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  ingress {
    description = "FTPS control"
    from_port   = 21
    to_port     = 21
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  ingress {
    description = "FTPS passive data"
    from_port   = 1024
    to_port     = 65535
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  ingress {
    description = "AS2 over HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${var.prefix}-mft-transfer" })
}

################################################################################
# Lambda VPC — outbound HTTPS (Entra ID); no inbound
################################################################################
resource "aws_security_group" "lambda" {
  provider    = aws.active
  name        = "${var.prefix}-mft-lambda"
  description = "Controls outbound access for the SFTP auth Lambda"
  vpc_id      = data.aws_vpc.this.id

  egress {
    description = "HTTPS outbound for Entra ID token endpoint"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${var.prefix}-mft-lambda" })
}

################################################################################
# Secrets Manager VPC interface endpoint — ingress from Lambda only
################################################################################
resource "aws_security_group" "secretsmanager_endpoint" {
  provider    = aws.active
  name        = "${var.prefix}-mft-secretsmanager-endpoint"
  description = "Controls access to the Secrets Manager VPC endpoint"
  vpc_id      = data.aws_vpc.this.id

  ingress {
    description     = "HTTPS from Lambda"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda.id]
  }

  tags = merge(local.common_tags, { Name = "${var.prefix}-mft-secretsmanager-endpoint" })
}

################################################################################
# EIPs — one per resolved subnet; positionally aligned with subnet_ids
################################################################################
resource "aws_eip" "mft" {
  count    = var.eip_count
  provider = aws.active
  domain   = "vpc"
  tags     = merge(local.common_tags, { Name = "${var.prefix}-mft-eip-${count.index}" })
}

################################################################################
# S3 Gateway VPC endpoint
################################################################################
resource "aws_vpc_endpoint" "s3" {
  provider          = aws.active
  vpc_id            = data.aws_vpc.this.id
  service_name      = "com.amazonaws.${local.active_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = data.aws_route_tables.public.ids
  tags              = merge(local.common_tags, { Name = "${var.prefix}-mft-s3-endpoint" })
}

################################################################################
# Secrets Manager interface VPC endpoint — private DNS; Lambda reaches Secrets
# Manager without traversing a NAT gateway
################################################################################
resource "aws_vpc_endpoint" "secretsmanager" {
  provider            = aws.active
  vpc_id              = data.aws_vpc.this.id
  service_name        = "com.amazonaws.${local.active_region}.secretsmanager"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = local.private_subnet_ids
  security_group_ids  = [aws_security_group.secretsmanager_endpoint.id]
  private_dns_enabled = true
  tags                = merge(local.common_tags, { Name = "${var.prefix}-mft-secretsmanager-endpoint" })
}

################################################################################
# KMS multi-region keys — primary mode provisions the primary key in the active
# region and a replica in the passive region (same key material across regions);
# DR mode references both via aliases as data sources.
################################################################################

# Default bucket encryption key — primary in active region
resource "aws_kms_key" "default" {
  count                   = var.dr_mode ? 0 : 1
  provider                = aws.active
  description             = "Default encryption key for ${var.prefix} SFTP Transfer Family S3 storage"
  multi_region            = true
  deletion_window_in_days = 30
  enable_key_rotation     = true
  tags                    = merge(local.common_tags, { Name = "${var.prefix}-mft-default" })
}

resource "aws_kms_alias" "default" {
  count         = var.dr_mode ? 0 : 1
  provider      = aws.active
  name          = "alias/${var.prefix}-mft-default"
  target_key_id = aws_kms_key.default[0].key_id
}

# Default key — replica in passive region (shares key material with the primary)
resource "aws_kms_replica_key" "default" {
  count                   = var.dr_mode ? 0 : 1
  provider                = aws.passive
  primary_key_arn         = aws_kms_key.default[0].arn
  description             = "Replica of ${var.prefix} SFTP default encryption key"
  deletion_window_in_days = 30
  tags                    = merge(local.common_tags, { Name = "${var.prefix}-mft-default-replica" })
}

resource "aws_kms_alias" "default_replica" {
  count         = var.dr_mode ? 0 : 1
  provider      = aws.passive
  name          = "alias/${var.prefix}-mft-default"
  target_key_id = aws_kms_replica_key.default[0].key_id
}

# Default key — data sources for DR mode (look up by alias in both regions)
data "aws_kms_key" "default_active" {
  count    = var.dr_mode ? 1 : 0
  provider = aws.active
  key_id   = "alias/${var.prefix}-mft-default"
}

data "aws_kms_key" "default_passive" {
  count    = var.dr_mode ? 1 : 0
  provider = aws.passive
  key_id   = "alias/${var.prefix}-mft-default"
}

################################################################################
# S3 primary + DR buckets — created in primary mode only
################################################################################
resource "aws_s3_bucket" "primary" {
  count    = var.dr_mode ? 0 : 1
  provider = aws.active
  bucket   = local.s3_primary_bucket_name
  tags     = merge(local.common_tags, { Name = local.s3_primary_bucket_name, Role = "primary" })
}

resource "aws_s3_bucket_versioning" "primary" {
  count    = var.dr_mode ? 0 : 1
  provider = aws.active
  bucket   = aws_s3_bucket.primary[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "primary" {
  count    = var.dr_mode ? 0 : 1
  provider = aws.active
  bucket   = aws_s3_bucket.primary[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = local.default_key_active_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "primary" {
  count                   = var.dr_mode ? 0 : 1
  provider                = aws.active
  bucket                  = aws_s3_bucket.primary[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "primary" {
  count    = var.dr_mode ? 0 : 1
  provider = aws.active
  bucket   = aws_s3_bucket.primary[0].id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

resource "aws_s3_bucket" "dr" {
  count    = var.dr_mode ? 0 : 1
  provider = aws.passive
  bucket   = local.s3_dr_bucket_name
  tags     = merge(local.common_tags, { Name = local.s3_dr_bucket_name, Role = "dr" })
}

resource "aws_s3_bucket_versioning" "dr" {
  count    = var.dr_mode ? 0 : 1
  provider = aws.passive
  bucket   = aws_s3_bucket.dr[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

# DR bucket uses the multi-region replica key in the passive region, so primary
# objects can be decrypted in DR without re-encryption (same key material).
resource "aws_s3_bucket_server_side_encryption_configuration" "dr" {
  count    = var.dr_mode ? 0 : 1
  provider = aws.passive
  bucket   = aws_s3_bucket.dr[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = local.default_key_passive_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "dr" {
  count                   = var.dr_mode ? 0 : 1
  provider                = aws.passive
  bucket                  = aws_s3_bucket.dr[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "dr" {
  count    = var.dr_mode ? 0 : 1
  provider = aws.passive
  bucket   = aws_s3_bucket.dr[0].id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

################################################################################
# S3 bucket data sources — DR mode only
################################################################################
data "aws_s3_bucket" "source" {
  count    = var.dr_mode ? 1 : 0
  provider = aws.active
  bucket   = local.source_bucket_name
}

data "aws_s3_bucket" "replica" {
  count    = var.dr_mode ? 1 : 0
  provider = aws.passive
  bucket   = local.replica_bucket_name
}

################################################################################
# S3 replication configuration — always active-to-passive via locals
################################################################################
resource "aws_s3_bucket_replication_configuration" "mft" {
  provider = aws.active
  bucket   = var.dr_mode ? data.aws_s3_bucket.source[0].id : aws_s3_bucket.primary[0].id
  role     = aws_iam_role.replication.arn

  rule {
    id     = "mft-crr"
    status = "Enabled"

    filter {}

    delete_marker_replication {
      status = "Disabled"
    }

    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }

    destination {
      bucket        = var.dr_mode ? "arn:aws:s3:::${local.replica_bucket_name}" : aws_s3_bucket.dr[0].arn
      storage_class = "STANDARD"

      encryption_configuration {
        replica_kms_key_id = local.default_key_passive_arn
      }
    }
  }

  depends_on = [
    aws_s3_bucket_versioning.primary,
    aws_s3_bucket_versioning.dr
  ]
}

################################################################################
# Transfer Family server — SFTP + FTPS + AS2, VPC endpoint, ACM cert
################################################################################
resource "aws_transfer_server" "mft" {
  provider               = aws.active
  identity_provider_type = "AWS_LAMBDA"
  protocols              = ["AS2", "FTPS", "SFTP"]
  endpoint_type          = "VPC"
  domain                 = "S3"
  security_policy_name   = "TransferSecurityPolicy-2023-05"

  endpoint_details {
    vpc_id                 = data.aws_vpc.this.id
    subnet_ids             = local.public_subnet_ids
    address_allocation_ids = aws_eip.mft[*].allocation_id
    security_group_ids     = [aws_security_group.transfer.id]
  }

  # AS2 over HTTPS — the Transfer Family API requires as2_transports to be set
  # whenever AS2 is in protocols. HTTP is the only supported transport value;
  # TLS is provided by the security policy and ACM certificate.
  protocol_details {
    as2_transports = ["HTTP"]
  }

  certificate  = aws_acm_certificate_validation.mft.certificate_arn
  function     = aws_lambda_function.auth.arn
  logging_role = aws_iam_role.transfer_logging.arn

  tags = merge(local.common_tags, { Name = "${var.prefix}-mft-server" })
}

################################################################################
# SSM parameters for cross-stack reference convention
################################################################################
resource "aws_ssm_parameter" "transfer_server_id" {
  provider = aws.active
  name     = "/${var.prefix}/mft/server-id"
  type     = "String"
  value    = aws_transfer_server.mft.id
  tags     = local.common_tags
}

resource "aws_ssm_parameter" "s3_source_bucket" {
  provider = aws.active
  name     = "/${var.prefix}/mft/bucket-name"
  type     = "String"
  value    = local.source_bucket_name
  tags     = local.common_tags
}
