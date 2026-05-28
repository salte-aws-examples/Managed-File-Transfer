output "transfer_server_id" {
  description = "Transfer Family server ID"
  value       = aws_transfer_server.mft.id
}

output "transfer_server_endpoint" {
  description = "Transfer Family VPC endpoint hostname"
  value       = aws_transfer_server.mft.endpoint
}

output "mft_eips" {
  description = "Elastic IP addresses assigned to the MFT server"
  value       = aws_eip.mft[*].public_ip
}

output "active_region" {
  description = "Region where Transfer Family is currently active"
  value       = local.active_region
}

output "dr_mode_active" {
  description = "Whether DR mode is currently active"
  value       = var.dr_mode
}

output "acm_certificate_arn" {
  description = "ACM certificate ARN"
  value       = aws_acm_certificate_validation.mft.certificate_arn
}

output "s3_source_bucket" {
  description = "S3 bucket name currently serving as the MFT backing store"
  value       = local.source_bucket_name
}

output "kms_default_key_arn" {
  description = "ARN of the default multi-region KMS key (primary region)"
  value       = var.dr_mode ? data.aws_kms_key.default_active[0].arn : aws_kms_key.default[0].arn
}

output "kms_default_replica_key_arn" {
  description = "ARN of the default multi-region KMS replica key (passive region)"
  value       = var.dr_mode ? data.aws_kms_key.default_passive[0].arn : aws_kms_replica_key.default[0].arn
}

output "auth_lambda_arn" {
  description = "ARN of the Transfer Family auth Lambda function"
  value       = aws_lambda_function.auth.arn
}

output "entra_config_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the Entra ID tenant_id, client_id, and client_secret consumed by the auth Lambda at runtime. The secret is provisioned outside this stack."
  value       = data.aws_secretsmanager_secret.entra_config.arn
}
