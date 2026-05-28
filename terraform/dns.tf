################################################################################
# ACM certificate — provisioned in the active region for the SFTP hostname
################################################################################
resource "aws_acm_certificate" "mft" {
  provider          = aws.acm
  domain_name       = local.mft_hostname
  validation_method = "DNS"
  tags              = merge(local.common_tags, { Name = "${var.prefix}-mft-cert" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  provider = aws.active

  for_each = {
    for dvo in aws_acm_certificate.mft.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  zone_id         = data.aws_route53_zone.public.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
}

resource "aws_acm_certificate_validation" "mft" {
  provider                = aws.acm
  certificate_arn         = aws_acm_certificate.mft.arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

################################################################################
# Hosted zones — public is a data source; private is managed in primary mode
# and referenced as a data source in DR mode
################################################################################
data "aws_route53_zone" "public" {
  provider     = aws.active
  name         = var.public_hosted_zone_name
  private_zone = false
}

resource "aws_route53_zone" "private" {
  count    = var.dr_mode ? 0 : 1
  provider = aws.active
  name     = local.private_hosted_zone_name

  vpc {
    vpc_id     = data.aws_vpc.this.id
    vpc_region = local.active_region
  }

  tags = merge(local.common_tags, { Name = "${local.private_hosted_zone_name}-private" })
}

data "aws_route53_zone" "private" {
  count        = var.dr_mode ? 1 : 0
  provider     = aws.active
  name         = local.private_hosted_zone_name
  private_zone = true
}

# DR mode: associate the pre-existing private hosted zone with the DR VPC
resource "aws_route53_zone_association" "dr" {
  count      = var.dr_mode ? 1 : 0
  provider   = aws.active
  zone_id    = data.aws_route53_zone.private[0].zone_id
  vpc_id     = data.aws_vpc.this.id
  vpc_region = local.active_region
}

################################################################################
# Route 53 records — split-brain DNS, overwriteable for DR failover/failback
################################################################################
resource "aws_route53_record" "mft_public" {
  provider        = aws.active
  zone_id         = data.aws_route53_zone.public.zone_id
  name            = local.mft_hostname
  type            = "A"
  ttl             = 60
  records         = aws_eip.mft[*].public_ip
  allow_overwrite = true
}

resource "aws_route53_record" "mft_private" {
  provider        = aws.active
  zone_id         = local.private_zone_id
  name            = local.mft_hostname
  type            = "CNAME"
  ttl             = 60
  records         = [aws_transfer_server.mft.endpoint]
  allow_overwrite = true
}
