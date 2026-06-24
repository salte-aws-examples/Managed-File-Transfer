variable "allowed_cidr_blocks" {
  description = "List of CIDR blocks permitted inbound access to the Transfer Family endpoint (SFTP port 22, FTPS port 21, AS2 port 443)."
  type        = list(string)
}

variable "commit_hash" {
  description = "Commit hash"
  type        = string
}

variable "dr_mode" {
  description = "When true, provisions DR region infrastructure and reverses replication/DNS. When false, provisions primary region infrastructure."
  type        = bool
  default     = false
}

variable "dr_region" {
  description = "Disaster recovery AWS region"
  type        = string
  default     = "us-west-2"
}

variable "eip_count" {
  description = "Number of EIPs and corresponding AZs to provision for the Transfer Family endpoint. Defaults to 2 for Multi-AZ HA. Must not exceed the number of private subnets available in the active region. Set to 1 for sandbox environments to stay within default AWS EIP limits."
  type        = number
  default     = 2
}

variable "git_repository" {
  description = "Git repository name"
  type        = string
}

variable "prefix" {
  description = "Short identifier used to namespace all resource names, aliases, and tags. Override to match your organization (e.g. 'acme'). Default is 'salte' for sandbox testing."
  type        = string
  default     = "salte"
}

variable "primary_region" {
  description = "Primary AWS region for the MFT solution"
  type        = string
  default     = "us-east-1"
}

variable "public_hosted_zone_name" {
  description = "Public Route 53 hosted zone name (e.g. your-domain.com). Must be pre-provisioned in the target account."
  type        = string
}

variable "sample_ftps_entra_client_id" {
  description = "Entra ID app registration client ID for the sample FTPS transfer (sample-ftps-test). Used to seed the DynamoDB users table for testing."
  type        = string
  default     = ""
}

variable "sample_sftp_entra_client_id" {
  description = "Entra ID app registration client ID for the sample SFTP + Entra transfer (sample-sftp-entra-test). Used to seed the DynamoDB users table for testing."
  type        = string
  default     = ""
}

variable "sample_sftp_ssh_public_key" {
  description = "SSH public key for the sample SFTP + SSH key transfer (sample-sftp-test). Used to seed the DynamoDB users table for testing. Optional — leave empty to create the record without a key."
  type        = string
  default     = ""
}

variable "auth_verbose_logging" {
  description = "When true, sets VERBOSE_LOGGING=true on the auth Lambda to log all authentication requests (excluding passwords)."
  type        = bool
  default     = false
}
