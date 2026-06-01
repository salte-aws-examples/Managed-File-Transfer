locals {
  active_region  = var.dr_mode ? var.dr_region : var.primary_region
  passive_region = var.dr_mode ? var.primary_region : var.dr_region

  # Sliced and sorted so EIP count and Transfer Family subnet_ids stay aligned
  # and the AZ selection is deterministic across applies.
  public_subnet_ids = slice(sort(data.aws_subnets.public.ids), 0, var.eip_count)

  # Private subnets for Lambda + Secrets Manager interface endpoint — same
  # slice length as eip_count so AZ coverage stays aligned with Transfer Family.
  private_subnet_ids = slice(sort(data.aws_subnets.private.ids), 0, var.eip_count)

  # All resource names are namespaced under the prefix
  s3_primary_bucket_name = "${var.prefix}-mft-${data.aws_caller_identity.active.account_id}-${data.aws_region.active.name}"
  s3_dr_bucket_name      = "${var.prefix}-mft-${data.aws_caller_identity.active.account_id}-${data.aws_region.passive.name}"

  # Source bucket is where Transfer Family writes; replica is the passive side
  source_bucket_name  = var.dr_mode ? local.s3_dr_bucket_name : local.s3_primary_bucket_name
  replica_bucket_name = var.dr_mode ? local.s3_primary_bucket_name : local.s3_dr_bucket_name

  mft_hostname = "ftp.${var.public_hosted_zone_name}"

  private_hosted_zone_name = var.public_hosted_zone_name

  # Resolves to the data source in DR mode, the managed resource in primary mode
  private_zone_id = var.dr_mode ? data.aws_route53_zone.private[0].zone_id : aws_route53_zone.private[0].zone_id

  # Multi-region KMS key ARNs — resolve to the data source in DR mode, the
  # managed resource (primary or replica) in primary mode. Always region-correct.
  default_key_active_arn  = var.dr_mode ? data.aws_kms_key.default_active[0].arn : aws_kms_key.default[0].arn
  default_key_passive_arn = var.dr_mode ? data.aws_kms_key.default_passive[0].arn : aws_kms_replica_key.default[0].arn

  common_tags = {
    GitRepository = var.git_repository
    CommitHash    = var.commit_hash
    ManagedBy     = "terraform"
  }

  entra_config_secret = "${var.prefix}/mft/entra"

  vpc_id = data.aws_vpc.this.id
}
