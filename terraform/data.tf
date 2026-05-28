data "aws_vpc" "this" { provider = aws.active }

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

data "aws_route_tables" "public" {
  provider = aws.active
  vpc_id   = data.aws_vpc.this.id

  filter {
    name   = "association.subnet-id"
    values = local.public_subnet_ids
  }
}

data "aws_region" "active" { provider = aws.active }

data "aws_region" "passive" { provider = aws.passive }

data "aws_caller_identity" "active" { provider = aws.active }

# Entra ID configuration secret — provisioned out-of-band (separate secrets
# management process). Contains a JSON object with entra_tenant_id,
# entra_client_id, and entra_client_secret. The Lambda reads it at runtime;
# this stack only needs the ARN to grant secretsmanager:GetSecretValue on it.
data "aws_secretsmanager_secret" "entra_config" {
  provider = aws.active
  name     = local.entra_config_secret
}
