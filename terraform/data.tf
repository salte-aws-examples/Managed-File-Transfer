data "archive_file" "auth_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../.build/lambda/auth"
  output_path = "${path.module}/../.build/lambda/auth.zip"
}

data "aws_caller_identity" "active" { provider = aws.active }

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

data "aws_region" "active" { provider = aws.active }

data "aws_region" "passive" { provider = aws.passive }

data "aws_route53_zone" "private" {
  count        = var.dr_mode ? 1 : 0
  provider     = aws.active
  name         = local.private_hosted_zone_name
  private_zone = true
}

data "aws_route53_zone" "public" {
  provider     = aws.active
  name         = var.public_hosted_zone_name
  private_zone = false
}

data "aws_route_tables" "private" {
  provider = aws.active
  vpc_id   = local.vpc_id

  filter {
    name   = "association.subnet-id"
    values = local.private_subnet_ids
  }
}

data "aws_route_tables" "public" {
  provider = aws.active
  vpc_id   = data.aws_vpc.this.id

  filter {
    name   = "association.subnet-id"
    values = local.public_subnet_ids
  }
}

data "aws_s3_bucket" "replica" {
  count    = var.dr_mode ? 1 : 0
  provider = aws.active
  bucket   = local.replica_bucket_name
}

data "aws_s3_bucket" "source" {
  count    = var.dr_mode ? 1 : 0
  provider = aws.passive
  bucket   = local.source_bucket_name
}

# Entra ID configuration secret — provisioned out-of-band (separate secrets
# management process). Contains a JSON object with entra_tenant_id,
# entra_client_id, and entra_client_secret. The Lambda reads it at runtime;
# this stack only needs the ARN to grant secretsmanager:GetSecretValue on it.
data "aws_secretsmanager_secret" "entra_config" {
  provider = aws.active
  name     = local.entra_config_secret
}

data "aws_subnets" "private" {
  provider = aws.active

  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.this.id]
  }

  tags = {
    Type = "private"
  }
}

data "aws_subnets" "public" {
  provider = aws.active

  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.this.id]
  }

  tags = {
    Type = "public"
  }
}

data "aws_vpc" "this" { provider = aws.active }
