################################################################################
# DynamoDB gateway VPC endpoint — private subnet route tables only
################################################################################
data "aws_route_tables" "private" {
  provider = aws.active
  vpc_id   = local.vpc_id

  filter {
    name   = "association.subnet-id"
    values = local.private_subnet_ids
  }
}

resource "aws_vpc_endpoint" "dynamodb" {
  provider          = aws.active
  vpc_id            = local.vpc_id
  service_name      = "com.amazonaws.${local.active_region}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = data.aws_route_tables.private.ids
  tags              = merge(local.common_tags, { Name = "${var.prefix}-mft-dynamodb-endpoint" })
}

################################################################################
# DynamoDB global tables — provisioned in primary mode only
################################################################################
resource "aws_dynamodb_table" "carriers" {
  count        = var.dr_mode ? 0 : 1
  provider     = aws.active
  name         = "${var.prefix}-mft-carriers"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "carrierId"

  attribute {
    name = "carrierId"
    type = "S"
  }

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  replica {
    region_name = var.dr_region
  }

  tags = merge(local.common_tags, { Name = "${var.prefix}-mft-carriers" })
}

resource "aws_dynamodb_table" "partners" {
  count        = var.dr_mode ? 0 : 1
  provider     = aws.active
  name         = "${var.prefix}-mft-partners"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "partnerId"

  attribute {
    name = "partnerId"
    type = "S"
  }

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  replica {
    region_name = var.dr_region
  }

  tags = merge(local.common_tags, { Name = "${var.prefix}-mft-partners" })
}

resource "aws_dynamodb_table" "transfer_types" {
  count        = var.dr_mode ? 0 : 1
  provider     = aws.active
  name         = "${var.prefix}-mft-transfer-types"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "transferTypeId"

  attribute {
    name = "transferTypeId"
    type = "S"
  }

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  replica {
    region_name = var.dr_region
  }

  tags = merge(local.common_tags, { Name = "${var.prefix}-mft-transfer-types" })
}

resource "aws_dynamodb_table" "users" {
  count        = var.dr_mode ? 0 : 1
  provider     = aws.active
  name         = "${var.prefix}-mft-users"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "username"

  attribute {
    name = "username"
    type = "S"
  }

  attribute {
    name = "carrierId"
    type = "S"
  }

  attribute {
    name = "partnerId"
    type = "S"
  }

  attribute {
    name = "status"
    type = "S"
  }

  global_secondary_index {
    name            = "carrierId-index"
    hash_key        = "carrierId"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "partnerId-index"
    hash_key        = "partnerId"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "status-index"
    hash_key        = "status"
    projection_type = "ALL"
  }

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  replica {
    region_name = var.dr_region
  }

  tags = merge(local.common_tags, { Name = "${var.prefix}-mft-users" })
}
