# MFT (Managed File Transfer) — Cursor Implementation Spec

## Overview

This spec instructs Cursor to implement an AWS Transfer Family MFT solution (SFTP/FTPS/AS2) scaffolded with Terraflow, designed for active/DR operation across two AWS regions. The solution supports a clean DR failover and failback workflow using two independent Terraform state files — one per region — with no cross-state imports required.

Authentication is delegated to a Lambda identity provider backed by DynamoDB. Transfer Family invokes the Lambda directly for every FTPS and SFTP connection. The Lambda looks up the username in the DynamoDB `users` table, validates Entra credentials (FTPS and SFTP without stored key) including JWT `roles` claim cross-check, or returns `PublicKeys` from DynamoDB for SFTP+SSH users so Transfer Family performs key verification. Session role ARN and home directory are derived from DynamoDB record fields.

All resource names, tags, bucket names, and aliases are driven by a `prefix` input variable. No organization-specific names are hardcoded anywhere in this module.

---

## Prerequisites

Terraflow must be installed globally before beginning:

```bash
npm install -g @salte-common/terraflow
```

Scaffold the project using the Terraflow CLI, substituting your chosen prefix for the project name:

```bash
terraflow new ${prefix}-managed-file-transfer --provider aws --language typescript
cd ${prefix}-managed-file-transfer
```

This creates the standard Terraflow project structure including `.tfwconfig.yml`, `.cursor/rules/`, `terraform/`, and supporting files. All Terraform implementation goes inside the scaffolded `terraform/` directory following Terraflow's conventional file layout: `_init.tf`, `inputs.tf`, `locals.tf`, `main.tf`, `outputs.tf`, and a `modules/` subdirectory.

---

## How to Use This Spec

1. Run the `terraflow new` scaffold command above manually in your terminal
2. Place this file as `SPECIFICATION.md` in the project root
3. Open the scaffolded project directory in Cursor
4. Run the Cursor prompts provided at the end of this spec in order

---

## Terraflow Configuration

Update the scaffolded `.tfwconfig.yml` to the following. Terraflow resolves `${AWS_REGION}` and `${AWS_ACCOUNT_ID}` at runtime from environment variables, so setting `AWS_REGION=us-east-1` targets the primary state bucket and `AWS_REGION=us-west-2` targets the DR state bucket automatically:

```yaml
provider: aws

backend:
  type: s3
  config:
    bucket: ${AWS_REGION}-${AWS_ACCOUNT_ID}-terraform-state
    key: ${GIT_REPOSITORY}
    region: ${AWS_REGION}
    dynamodb_table: terraform-statelock
    encrypt: true
    kms_key_id: arn:aws:kms:${AWS_REGION}:${AWS_ACCOUNT_ID}:alias/${AWS_REGION}-${AWS_ACCOUNT_ID}-terraform-state

variables:
  git_repository: ${GITHUB_REPOSITORY}
  commit_hash: "${GIT_COMMIT_SHA}"
  allowed_cidr_blocks: "${ALLOWED_CIDR_BLOCKS}"
```

Terraflow resolves all values from environment variables at runtime. The state key is automatically the GitHub repository name via `${GIT_REPOSITORY}`, so the state bucket path is always `${AWS_REGION}-${AWS_ACCOUNT_ID}-terraform-state/${GIT_REPOSITORY}/terraform.tfstate`. No hardcoded values are needed in this file. The `git_repository`, `commit_hash`, and `allowed_cidr_blocks` input variables are injected automatically by Terraflow from the environment — they do not need to be passed on the command line.

---

## Input Variables (`terraform/inputs.tf`)

Define the following variables in alphabetical order. Cursor must not hardcode any organization name, region, bucket name, or hostname — all such values must flow from these variables or be derived in locals. VPC ID and subnet IDs are resolved via internal data source lookups and are not accepted as inputs.

```hcl
variable "allowed_cidr_blocks" {
  description = "List of CIDR blocks permitted inbound access to the Transfer Family endpoint (SFTP port 22, FTPS port 21, AS2 port 443)."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "commit_hash" {
  description = "Commit hash of the deployment. Used for resource tagging to provide deployment provenance."
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
  description = "Git repository name. Used for resource tagging to provide deployment provenance."
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
  default     = "ezipam.com"
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
```

---

## Locals (`terraform/locals.tf`)

```hcl
locals {
  active_region  = var.dr_mode ? var.dr_region : var.primary_region
  passive_region = var.dr_mode ? var.primary_region : var.dr_region

  # Environment is derived from the Terraform workspace name rather than an input
  # variable. Accounts are separated by environment in general; side-by-side
  # development deployments (e.g. formal dev branch vs preview branches) use
  # the workspace name to namespace resources within the same account.
  environment = terraform.workspace

  # S3 bucket names are globally unique by construction — prefix + account ID + region
  s3_primary_bucket_name = "${var.prefix}-mft-${data.aws_caller_identity.active.account_id}-${data.aws_region.active.name}"
  s3_dr_bucket_name      = "${var.prefix}-mft-${data.aws_caller_identity.active.account_id}-${data.aws_region.passive.name}"

  # Source bucket is where Transfer Family writes; replica is the passive side
  source_bucket_name  = var.dr_mode ? local.s3_dr_bucket_name : local.s3_primary_bucket_name
  replica_bucket_name = var.dr_mode ? local.s3_primary_bucket_name : local.s3_dr_bucket_name

  # MFT hostname derived from public hosted zone — no override needed
  mft_hostname = "ftp.${var.public_hosted_zone_name}"

  # Private zone uses the same name as the public zone (split-brain DNS)
  private_hosted_zone_name = var.public_hosted_zone_name

  # VPC and subnets are resolved via data source lookups — not accepted as inputs.
  # Public subnets are used for Transfer Family and EIPs so they are externally
  # accessible via EIP. Private subnets are used for the Lambda and Secrets Manager
  # VPC endpoint. public_subnet_ids is sliced to var.eip_count so EIP count and
  # subnet count passed to Transfer Family endpoint_details are always in sync.
  vpc_id              = data.aws_vpc.active.id
  public_subnet_ids   = slice(sort(data.aws_subnets.public.ids), 0, var.eip_count)
  private_subnet_ids  = slice(sort(data.aws_subnets.private.ids), 0, var.eip_count)

  # Entra ID configuration secret name — derived from prefix and passed to the
  # auth Lambda as the ENTRA_CONFIG_SECRET environment variable. The secret
  # itself is provisioned outside this stack.
  entra_config_secret = "${var.prefix}/mft/entra"

  common_tags = {
    Project       = "${var.prefix}-mft-transfer"
    Environment   = local.environment
    ManagedBy     = "terraform"
    Prefix        = var.prefix
    DR_Mode       = tostring(var.dr_mode)
    CommitHash    = var.commit_hash
    GitRepository = var.git_repository
  }
}

# KMS key ARN resolution — works in both primary and DR mode
locals {
  default_key_active_arn  = var.dr_mode ? data.aws_kms_key.default_active[0].arn : aws_kms_key.default[0].arn
  default_key_passive_arn = var.dr_mode ? data.aws_kms_key.default_passive[0].arn : aws_kms_replica_key.default[0].arn
}
```

---

## Provider Configuration (`terraform/_init.tf`)

`_init.tf` is the Terraflow convention for provider and backend configuration. The leading underscore ensures it sorts first alphabetically, establishing a predictable reading order across all Terraflow projects. Both the `terraform {}` required providers block and all `provider` aliases belong here and nowhere else. Cursor must not place any provider configuration in any other file.

```hcl
terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  alias  = "active"
  region = local.active_region
}

provider "aws" {
  alias  = "passive"
  region = local.passive_region
}

# ACM certificate must be provisioned in the active region
provider "aws" {
  alias  = "acm"
  region = local.active_region
}
```

---

## Architecture

### Primary Mode (`dr_mode = false`)

The following resources are provisioned in the primary region:

- **Security Group** — Controls inbound access to the Transfer Family VPC endpoint on ports 22 (SFTP), 21/1024-65535 (FTPS passive), and 443 (AS2). Restricted to `var.allowed_cidr_blocks`.
- **EIPs** — `var.eip_count` Elastic IPs assigned to the Transfer Family server endpoint. Defaults to 2 for Multi-AZ HA.
- **AWS Transfer Family Server** — Multi-AZ managed server provisioned in **public subnets** with VPC endpoint type, protocols SFTP + FTPS + AS2, `identity_provider_type = "AWS_LAMBDA"`, custom hostname, and ACM certificate attached. Public subnets are required so EIPs are reachable from the internet.
- **Lambda Auth Broker** — Node.js Lambda function provisioned in **private subnets** with VPC config, invoked directly by Transfer Family for every SFTP and FTPS authentication attempt. Looks up the username in the DynamoDB users table to retrieve routing config (carrier, partner, transfer type, env, protocol, session role). For FTPS validates partner credentials against Entra ID using the OAuth2 client credentials flow with `.default` scope. For SFTP compares the public key from the event against the stored public key. Returns session role ARN and home directory to Transfer Family.
- **DynamoDB Global Tables** — Four global tables (`carriers`, `partners`, `transfer-types`, `users`) with replicas in both primary and DR regions. The Lambda reads from its local region's replica. The users table is the authoritative source for all partner routing configuration and credentials.
- **DynamoDB Gateway VPC Endpoint** — Free gateway endpoint allowing the Lambda to reach DynamoDB without traversing the NAT gateway.
- **Lambda Security Group** — Allows outbound HTTPS (443) only, for Entra ID token endpoint calls via NAT gateway.
- **Secrets Manager VPC Endpoint** — Interface endpoint in private subnets with private DNS enabled. Allows Lambda to reach Secrets Manager without traversing the NAT gateway. Dedicated security group allowing inbound 443 from the Lambda security group only.
- **Secrets Manager VPC Endpoint Security Group** — Inbound 443 from Lambda security group only.
- **Secrets Manager Secret (Entra Config)** — Referenced as a data source. Holds a JSON object with `entra_tenant_id`, `entra_client_id`, and `entra_client_secret`. Provisioned outside this Terraform stack by a separate secrets management process. The Lambda reads it at runtime; this stack only grants `secretsmanager:GetSecretValue` on its ARN.
- **CloudWatch Log Group (Lambda)** — Retention 90 days.
- **VPC Endpoint (S3 Gateway)** — S3 gateway endpoint in the VPC, associated with route tables in the private subnets.
- **KMS Key (Default)** — Multi-region CMK used as the bucket default encryption key. Primary alias: `alias/<prefix>-sftp-default`. Replica key with same alias in DR region. Primary mode only.
- **KMS Key (Sample Carrier)** — Multi-region CMK for the sample carrier. Primary alias: `alias/<prefix>-mft-sample-carrier`. Replica in DR region. Primary mode only.
- **S3 Bucket (Primary)** — SFTP backing store with versioning, SSE-KMS using the default KMS key, blocked public access, and server access logging.
- **S3 Bucket (DR)** — Replica bucket in DR region with versioning, SSE-KMS, and blocked public access.
- **S3 Replication Configuration** — CRR rule replicating primary → DR.
- **IAM Role for Replication** — Grants S3 permission to replicate objects between buckets including KMS permissions.
- **ACM Certificate** — Certificate for `ftp.<public_hosted_zone_name>` in primary region, DNS-validated.
- **Public Hosted Zone** — Referenced as a data source (must be pre-provisioned).
- **Private Hosted Zone** — Created in primary mode, associated with the active VPC.
- **Route 53 Records** — Public zone: A records pointing at EIPs. Private zone: CNAME pointing at `aws_transfer_server.mft.endpoint`. Both use `allow_overwrite = true`.
- **SSM Parameters** — Publish `transfer_server_id` and `s3_source_bucket` in both primary and DR mode using the active region provider. SSM Parameter Store is regional — provisioning in both regions ensures carrier and partner onboarding Terraform can look up values against whichever region is currently active.

### DR Mode (`dr_mode = true`)

S3 buckets and hosted zones are referenced as data sources only — they are not managed by DR state:

- **Security Group, EIPs, Transfer Family Server, Lambda Auth Broker, S3 Gateway VPC Endpoint, ACM Certificate** — Same as primary but in DR region.
- **Route 53 Records** — Overwrites public zone A records to DR EIPs and private zone CNAME to DR Transfer Family endpoint.
- **S3 Replication Configuration (DR direction)** — On DR bucket replicating back to primary.
- **Private Hosted Zone VPC Association** — Associates existing private hosted zone with DR VPC.

---

## Resource Implementation Details

### VPC and Subnet Data Sources

Each AWS account/region combination is assumed to have exactly one VPC. The VPC data source requires no filter. Public subnets are tagged `Type = public` and used for Transfer Family and EIPs. Private subnets are tagged `Type = private` and used for the Lambda and Secrets Manager VPC endpoint.

```hcl
data "aws_caller_identity" "active" {
  provider = aws.active
}

data "aws_region" "active" {
  provider = aws.active
}

data "aws_region" "passive" {
  provider = aws.passive
}

data "aws_vpc" "active" {
  provider = aws.active
}

data "aws_subnets" "public" {
  provider = aws.active

  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.active.id]
  }

  tags = {
    Type = "public"
  }
}

data "aws_subnets" "private" {
  provider = aws.active

  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.active.id]
  }

  tags = {
    Type = "private"
  }
}
```

### Security Group

```hcl
resource "aws_security_group" "transfer" {
  provider    = aws.active
  name        = "${var.prefix}-mft-transfer"
  description = "Controls inbound access to the Transfer Family VPC endpoint"
  vpc_id      = local.vpc_id

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
```

### EIPs

```hcl
resource "aws_eip" "mft" {
  count    = var.eip_count
  domain   = "vpc"
  provider = aws.active
  tags     = merge(local.common_tags, { Name = "${var.prefix}-mft-eip-${count.index}" })
}
```

### Transfer Family Server

`identity_provider_type = "AWS_LAMBDA"` enables Transfer Family to invoke the auth Lambda directly for every SFTP and FTPS authentication attempt. AS2 does not use the identity provider — it authenticates via trading partner agreements configured during partner onboarding.

```hcl
resource "aws_transfer_server" "mft" {
  provider               = aws.active
  identity_provider_type = "AWS_LAMBDA"
  protocols              = ["AS2", "FTPS", "SFTP"]
  endpoint_type          = "VPC"
  domain                 = "S3"
  security_policy_name   = "TransferSecurityPolicy-2023-05"

  endpoint_details {
    vpc_id                 = local.vpc_id
    subnet_ids             = local.public_subnet_ids
    address_allocation_ids = aws_eip.mft[*].allocation_id
    security_group_ids     = [aws_security_group.transfer.id]
  }

  certificate  = aws_acm_certificate_validation.mft.certificate_arn
  function     = aws_lambda_function.auth.arn
  logging_role = aws_iam_role.transfer_logging.arn

  tags = merge(local.common_tags, { Name = "${var.prefix}-mft-server" })
}
```

Note: `address_allocation_ids` and `subnet_ids` must be positionally aligned — both derived from `local.public_subnet_ids`.

### S3 Gateway VPC Endpoint

```hcl
data "aws_route_tables" "public" {
  provider = aws.active
  vpc_id   = local.vpc_id

  filter {
    name   = "association.subnet-id"
    values = local.public_subnet_ids
  }
}

resource "aws_vpc_endpoint" "s3" {
  provider          = aws.active
  vpc_id            = local.vpc_id
  service_name      = "com.amazonaws.${local.active_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = data.aws_route_tables.public.ids
  tags              = merge(local.common_tags, { Name = "${var.prefix}-mft-s3-endpoint" })
}
```

### KMS Keys (`terraform/main.tf`)

All keys use the multi-region pattern (`multi_region = true`). Primary keys are provisioned in primary mode only. Replica keys are provisioned in the passive region in primary mode and persist there. In DR mode all keys are referenced as data sources.

The default key encrypts all objects written by Transfer Family to the shared S3 bucket. Per-carrier KMS encryption is not enforced at the Transfer Family write layer — Transfer Family uses the bucket default key for all writes regardless of carrier prefix. Carrier-specific keys are available for downstream applications that read carrier data directly from S3.

Sample carrier KMS resources are in `terraform/sample.tf` — see that file for the sample carrier key pattern that carrier onboarding Terraform will follow in Phase 2.

```hcl
# --- Default bucket encryption key (multi-region) ---

resource "aws_kms_key" "default" {
  count                   = var.dr_mode ? 0 : 1
  provider                = aws.active
  description             = "Default multi-region encryption key for ${var.prefix} SFTP S3 storage (primary)"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  multi_region            = true
  tags                    = merge(local.common_tags, { Name = "${var.prefix}-mft-default-primary" })
}

resource "aws_kms_alias" "default" {
  count         = var.dr_mode ? 0 : 1
  provider      = aws.active
  name          = "alias/${var.prefix}-mft-default"
  target_key_id = aws_kms_key.default[0].key_id
}

resource "aws_kms_replica_key" "default" {
  count                   = var.dr_mode ? 0 : 1
  provider                = aws.passive
  description             = "Default multi-region encryption key for ${var.prefix} SFTP S3 storage (replica)"
  deletion_window_in_days = 30
  primary_key_arn         = aws_kms_key.default[0].arn
  tags                    = merge(local.common_tags, { Name = "${var.prefix}-mft-default-replica" })
}

resource "aws_kms_alias" "default_replica" {
  count         = var.dr_mode ? 0 : 1
  provider      = aws.passive
  name          = "alias/${var.prefix}-mft-default"
  target_key_id = aws_kms_replica_key.default[0].key_id
}

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
```

### S3 Buckets

Both buckets are provisioned in primary mode only. In DR mode both are referenced as data sources. Encryption uses `local.default_key_active_arn` on the primary bucket and `local.default_key_passive_arn` on the DR bucket. Enable versioning, public access block, and lifecycle rules to expire non-current versions after 90 days on both buckets.

```hcl
resource "aws_s3_bucket" "primary" {
  count    = var.dr_mode ? 0 : 1
  provider = aws.active
  bucket   = local.s3_primary_bucket_name
  tags     = merge(local.common_tags, { Name = local.s3_primary_bucket_name, Role = "primary" })
}

resource "aws_s3_bucket" "dr" {
  count    = var.dr_mode ? 0 : 1
  provider = aws.passive
  bucket   = local.s3_dr_bucket_name
  tags     = merge(local.common_tags, { Name = local.s3_dr_bucket_name, Role = "dr" })
}

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
```

### Cross-Region Replication

Multi-region keys share the same key material — no re-encryption occurs during replication. `replica_kms_key_id` references `local.default_key_passive_arn` so it resolves correctly in both primary and DR mode.

```hcl
resource "aws_s3_bucket_replication_configuration" "mft" {
  provider = aws.active
  bucket   = var.dr_mode ? data.aws_s3_bucket.source[0].id : aws_s3_bucket.primary[0].id
  role     = aws_iam_role.replication.arn

  rule {
    id     = "mft-crr"
    status = "Enabled"

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
```

### ACM Certificate

```hcl
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
```

### Hosted Zones

```hcl
data "aws_route53_zone" "public" {
  name         = var.public_hosted_zone_name
  private_zone = false
}

resource "aws_route53_zone" "private" {
  count = var.dr_mode ? 0 : 1
  name  = local.private_hosted_zone_name

  vpc {
    vpc_id     = local.vpc_id
    vpc_region = local.active_region
  }

  tags = merge(local.common_tags, { Name = "${local.private_hosted_zone_name}-private" })
}

data "aws_route53_zone" "private" {
  count        = var.dr_mode ? 1 : 0
  name         = local.private_hosted_zone_name
  private_zone = true
}

locals {
  private_zone_id = var.dr_mode ? data.aws_route53_zone.private[0].zone_id : aws_route53_zone.private[0].zone_id
}

resource "aws_route53_vpc_association" "dr" {
  count   = var.dr_mode ? 1 : 0
  zone_id = data.aws_route53_zone.private[0].zone_id
  vpc_id  = local.vpc_id
}
```

### Route 53 Records (Split-Brain DNS)

The public and private zones resolve differently — this is the entire point of split-brain DNS:

- **Public zone** — A records pointing at the EIPs. External partners reach Transfer Family over the internet.
- **Private zone** — CNAME pointing at the Transfer Family VPC endpoint internal DNS name (`aws_transfer_server.mft.endpoint`). Internal consumers resolve to the private network interfaces and traffic never leaves the VPC.

```hcl
resource "aws_route53_record" "mft_public" {
  zone_id         = data.aws_route53_zone.public.zone_id
  name            = local.mft_hostname
  type            = "A"
  ttl             = 60
  records         = aws_eip.mft[*].public_ip
  allow_overwrite = true
}

resource "aws_route53_record" "mft_private" {
  zone_id         = local.private_zone_id
  name            = local.mft_hostname
  type            = "CNAME"
  ttl             = 60
  records         = [aws_transfer_server.mft.endpoint]
  allow_overwrite = true
}
```

---

## Lambda Auth Broker (`terraform/lambda.tf`)

The Lambda is the authentication integration point between Transfer Family, DynamoDB, and Entra ID. Partner routing configuration and credential metadata (Entra client IDs, SSH public keys) live in the DynamoDB `users` table. Entra client secrets are passed transiently during auth calls; the Lambda Entra app config is read from Secrets Manager at runtime.

### Authentication Flow

**Universal rules — applied first regardless of protocol:**
1. Username must exist in DynamoDB — deny if not found
2. Record `status` must be `active` — deny if disabled
3. Partner record is loaded by `partnerId` from the user record
4. Source IP is validated against allowed CIDRs **before** any Entra or credential check — deny if restricted and `sourceIp` is missing or does not match
5. No further processing if any check fails
6. Derive `roleArn` and `homeDirectory` from DynamoDB record fields before credential routing

**Source IP allowlists** — `allowedSourceCidrs` on the `partners` table defines the default allowlist for all transfers under that partner. The same attribute on a `users` record optionally overrides the partner default when present with a valid non-empty JSON array (e.g. `["203.0.113.0/24"]`). An empty array or invalid value falls back to the partner list. When neither record defines CIDRs, no IP restriction is applied. `0.0.0.0/0` in the allowlist permits any source IP. Transfer Family supplies `event.sourceIp` on every Lambda auth invocation.

**Verbose logging** — when the Lambda environment variable `VERBOSE_LOGGING` is `true`, `1`, or `yes`, every auth request is logged (username, protocol, `serverId`, `sourceIp`, `hasPassword`). Passwords are never logged. When unset, only errors are logged. Terraform exposes this via `var.auth_verbose_logging`.

**Authentication routing logic:**

| Protocol | Public key in DynamoDB | Auth mechanism | Authorization validation |
|---|---|---|---|
| `ftps` | n/a | Entra ID client credentials | Token `roles` claim parsed and compared against DynamoDB carrierId, partnerId, transferTypeId, env |
| `sftp` | yes | `PublicKeys` returned from DynamoDB | Transfer Family validates client SSH key against returned `PublicKeys`; no password or Entra call in Lambda |
| `sftp` | no | Entra ID client credentials | Token `roles` claim parsed and compared against DynamoDB carrierId, partnerId, transferTypeId, env |
| `as2` | n/a | Certificate — Transfer Family native | Not Lambda-invoked |

The Lambda does **not** read `event.publicKey`. For SFTP users with a stored public key, the Lambda returns a session response including `PublicKeys: [storedKey]` after the DynamoDB lookup — no password is required on that path.

**Entra role claim validation** — for all Entra paths (FTPS and SFTP without SSH key), after the token is validated the Lambda reads the `roles` claim and parses it against the DynamoDB record:

```javascript
// Token roles claim format: mft-<carrierId>.<partnerId>.<transferTypeId>.<env>
const roleName = jwtPayload.roles?.[0];
if (!roleName) {
  console.error(`No roles claim in token for ${username}`);
  return {};
}
const roleWithoutPrefix = roleName.replace(/^mft-/, "");
const [roleCarrier, rolePartner, roleTransfer, roleEnv] = roleWithoutPrefix.split(".");

if (
  roleCarrier  !== carrierId  ||
  rolePartner  !== partnerId  ||
  roleTransfer !== transferId ||
  roleEnv      !== env
) {
  console.error(`Role claim mismatch for ${username}: token=${roleName}`);
  return {};
}
```

This means a valid Entra token is not sufficient on its own — the role claim must exactly match the DynamoDB record. Neither Entra nor DynamoDB alone can authorize access.

**Session role and home directory derivation** — derived from the DynamoDB record fields:
```javascript
const roleArn = `arn:aws:iam::${accountId}:role/mft-${record.carrierId}.${record.partnerId}.${record.transferTypeId}.${record.env}`;
const s3Folder = record.env === 'p' ? 'production' : 'non-production';
const homeDirectory = `/${bucket}/${s3Folder}/${record.carrierId}/${record.partnerId}/${record.transferTypeId}`;
```

### Role Name Convention and Derivation

IAM session roles follow the convention `mft-<carrierId>.<partnerId>.<transferTypeId>.<env>` where each segment is the lower kebab ID from the corresponding DynamoDB lookup table. The role name is derived at runtime from the DynamoDB user record — not parsed from the username or token.

Role name format: `mft-<carrier-id>.<partner-id>.<transfer-type-id>.<env>`

Environment values:

| DynamoDB `env` | S3 folder |
|---|---|
| `p` | `production` |
| `np` | `non-production` |

Derived values from DynamoDB record `{carrierId: "acme-mutual", partnerId: "workday", transferTypeId: "personnel", env: "p"}`:

| Value | Result |
|---|---|
| IAM role name | `mft-acme-mutual.workday.personnel.p` |
| IAM role ARN | `arn:aws:iam::<account-id>:role/mft-acme-mutual.workday.personnel.p` |
| Home directory | `/<bucket>/production/acme-mutual/workday/personnel` |

The session role is provisioned by the partner onboarding Terraform. Its S3 permissions are scoped to both the production and non-production prefixes for that carrier/partner/transfer-type — environment isolation is enforced by the home directory mapping returned by the Lambda, not by IAM.

**Lambda response shape** — on success the handler returns:

```json
{
  "Role": "arn:aws:iam::<account-id>:role/mft-<carrierId>.<partnerId>.<transferTypeId>.<env>",
  "HomeDirectoryType": "LOGICAL",
  "HomeDirectoryDetails": "[{\"Entry\":\"/\",\"Target\":\"/<bucket>/<production|non-production>/<carrierId>/<partnerId>/<transferTypeId>\"}]",
  "PublicKeys": ["ssh-rsa AAAA..."]
}
```

`PublicKeys` is included only when the DynamoDB user record has a stored `publicKey` (SFTP+SSH path).

### Lambda Security Group

The Lambda security group allows outbound HTTPS only — for Entra ID token endpoint calls via the NAT gateway. No inbound rules are needed since Transfer Family invokes the Lambda directly via the AWS API, not over the network.

```hcl
resource "aws_security_group" "lambda" {
  provider    = aws.active
  name        = "${var.prefix}-mft-lambda"
  description = "Controls outbound access for the SFTP auth Lambda"
  vpc_id      = local.vpc_id

  egress {
    description = "HTTPS outbound for Entra ID token endpoint"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${var.prefix}-mft-lambda" })
}
```

### Secrets Manager VPC Endpoint Security Group

Allows inbound 443 from the Lambda security group only. The Lambda reaches Secrets Manager via this endpoint without traversing the NAT gateway.

```hcl
resource "aws_security_group" "secretsmanager_endpoint" {
  provider    = aws.active
  name        = "${var.prefix}-mft-secretsmanager-endpoint"
  description = "Controls access to the Secrets Manager VPC endpoint"
  vpc_id      = local.vpc_id

  ingress {
    description     = "HTTPS from Lambda"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda.id]
  }

  tags = merge(local.common_tags, { Name = "${var.prefix}-mft-secretsmanager-endpoint" })
}
```

### Secrets Manager VPC Endpoint

Interface endpoint provisioned in private subnets with private DNS enabled. Private DNS means the Lambda resolves `secretsmanager.<region>.amazonaws.com` to the VPC endpoint automatically — no code changes needed.

```hcl
resource "aws_vpc_endpoint" "secretsmanager" {
  provider            = aws.active
  vpc_id              = local.vpc_id
  service_name        = "com.amazonaws.${local.active_region}.secretsmanager"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = local.private_subnet_ids
  security_group_ids  = [aws_security_group.secretsmanager_endpoint.id]
  private_dns_enabled = true
  tags                = merge(local.common_tags, { Name = "${var.prefix}-mft-secretsmanager-endpoint" })
}
```

### Lambda Function Resource

```hcl
resource "aws_lambda_function" "auth" {
  provider         = aws.active
  function_name    = "${var.prefix}-mft-auth"
  description      = "Transfer Family identity provider — looks up partner in DynamoDB, validates credentials against Entra ID (FTPS) or SSH public key (SFTP), returns session role and home directory"
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  role             = aws_iam_role.lambda_exec.arn
  filename         = data.archive_file.auth_lambda.output_path
  source_code_hash = data.archive_file.auth_lambda.output_base64sha256
  timeout          = 10
  memory_size      = 256

  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      ENTRA_CONFIG_SECRET = local.entra_config_secret
      S3_BUCKET_NAME      = local.source_bucket_name
      USERS_TABLE         = "${var.prefix}-mft-users"
    }
  }

  tags = merge(local.common_tags, { Name = "${var.prefix}-mft-auth" })
}

resource "aws_cloudwatch_log_group" "auth_lambda" {
  provider          = aws.active
  name              = "/aws/lambda/${var.prefix}-mft-auth"
  retention_in_days = 90
  tags              = local.common_tags
}
```

Note: `PREFIX` is no longer needed as a Lambda environment variable. Session role names are derived at runtime from DynamoDB fields (`mft-<carrierId>.<partnerId>.<transferTypeId>.<env>`). On Entra paths, the token `roles` claim must match those same DynamoDB fields.

> **Do not use `lambda/auth/index.mjs`.** Authoritative source is `src/main/auth/index.ts`, bundled to `.build/lambda/auth/index.js` via `npm run build:lambda`. Terraform zips `.build/lambda/auth`.

### Lambda Source Code and Build

| Artifact | Path |
|---|---|
| **Source** | `src/main/auth/index.ts` |
| **Tests** | `src/test/auth/index.test.ts` |
| **Build output** | `.build/lambda/auth/index.js` |
| **Zip output** | `.build/lambda/auth.zip` |

The handler flow (see `src/main/auth/index.ts` for the authoritative implementation):

1. DynamoDB lookup by `username`; deny if missing or `status !== "active"`
2. Derive `roleArn` and `homeDirectory` from record fields
3. If `protocol === "ftps"` or (`protocol === "sftp"` and no stored `publicKey`):
   - Require `password`; call `authenticateWithEntra()` using `item.clientId.S`
   - Validate JWT audience and `roles[0]` against DynamoDB fields
4. Else if `protocol === "sftp"` and stored `publicKey`: skip Entra; no password required
5. Return `{ Role, HomeDirectoryType, HomeDirectoryDetails }` and include `PublicKeys: [storedKey]` when the DynamoDB record has a stored public key

The Lambda does **not** read `event.publicKey`. SSH key verification is performed by Transfer Family using the `PublicKeys` field in the Lambda response.

Package the Lambda using a `data.archive_file` resource (zipping the `.build/` output):

```hcl
data "archive_file" "auth_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../.build/lambda/auth"
  output_path = "${path.module}/../.build/lambda/auth.zip"
}
```

### Secrets Manager Entra Config Secret

The Entra ID configuration (tenant ID, client ID, client secret) is stored in a single AWS Secrets Manager secret whose value is a JSON object. The secret is provisioned outside this Terraform stack by a separate secrets management process — Terraform references it as a data source only.

The secret name is derived from `var.prefix` and exposed as a local for use in the Lambda environment:

```hcl
# locals.tf
entra_config_secret = "${var.prefix}/mft/entra"
```

With `prefix = "salte"` the secret name resolves to `salte/mft/entra`. The data source lookup belongs in `terraform/data.tf`:

```hcl
data "aws_secretsmanager_secret" "entra_config" {
  provider = aws.active
  name     = local.entra_config_secret
}
```

The secret value must be a JSON object with these exact keys:

```json
{
  "entra_tenant_id": "<entra-tenant-id>",
  "entra_client_id": "<lambda-app-registration-client-id>",
  "entra_client_secret": "<lambda-app-registration-client-secret>"
}
```

Encryption: the secret uses the AWS-managed key (`aws/secretsmanager`); no `kms:Decrypt` IAM grant on a CMK is required. If the operating team later migrates the secret to a customer-managed key, the Lambda execution role policy must be extended with a `kms:Decrypt` statement on the CMK ARN.

---

## Bucket Folder Structure

```
<bucket>/
├── production/
│   └── <carrier>/
│       └── <partner>/
│           └── <transfer-type>/
│               ├── inbound/
│               └── outbound/
└── non-production/
    └── <carrier>/
        └── <partner>/
            └── <transfer-type>/
                ├── inbound/
                └── outbound/
```

The Lambda home directory mapping points to `/<bucket>/<environment>/<carrier>/<partner>/<transfer-type>`. The partner's FTPS/SFTP client lands at this root and navigates to `inbound/` or `outbound/` from there.

---

## IAM Resources (`terraform/iam.tf`)

### Lambda Execution Role

The Lambda execution role has minimal permissions — Secrets Manager read on the externally-provisioned Entra config secret and CloudWatch Logs write. It has no S3 access and no ability to assume other roles.

```hcl
resource "aws_iam_role" "lambda_exec" {
  name     = "${var.prefix}-mft-lambda-exec"
  provider = aws.active

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy" "lambda_exec" {
  name     = "${var.prefix}-mft-lambda-exec"
  role     = aws_iam_role.lambda_exec.id
  provider = aws.active

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = "arn:aws:dynamodb:${local.active_region}:${data.aws_caller_identity.active.account_id}:table/${var.prefix}-mft-users"
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = data.aws_secretsmanager_secret.entra_config.arn
      }
    ]
  })
}
```

### Transfer Family Lambda Invocation Permission

When `identity_provider_type = "AWS_LAMBDA"`, Transfer Family invokes the Lambda **directly** rather than assuming an invocation role. Permission is granted through a Lambda resource-based policy (`aws_lambda_permission`), and **`invocation_role` must NOT be set on the server** — the AWS API explicitly rejects servers that have both `AWS_LAMBDA` and an invocation role configured.

```hcl
resource "aws_lambda_permission" "transfer_invoke_auth" {
  provider      = aws.active
  statement_id  = "AllowTransferFamilyInvocation"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.auth.function_name
  principal     = "transfer.amazonaws.com"
  source_arn    = aws_transfer_server.mft.arn
}
```

Note: `source_arn` scopes the grant to this specific Transfer Family server only. Without it, any Transfer Family server in the account could invoke this Lambda. The `aws_lambda_permission` depends on `aws_transfer_server.mft` via the `source_arn` reference, so Terraform creates the permission **after** the server. During the short apply window between server creation and permission creation, SFTP connections will fail to authenticate; this is fine because the server isn't reachable by partners during apply.

Contrast: when `identity_provider_type = "API_GATEWAY"`, Transfer Family **does** require an `invocation_role` on the server (so it can sign API Gateway requests). The `AWS_LAMBDA` provider type uses a different mechanism and does not.

---

## DynamoDB Global Tables (`terraform/dynamodb.tf`)

Four DynamoDB global tables are provisioned with replicas in both primary and DR regions. Global tables provide active-active replication — the Lambda in either region reads from its local replica with low latency, and failover requires no configuration change.

All tables use on-demand billing and are provisioned in primary mode only (`count = var.dr_mode ? 0 : 1`). In DR mode they are referenced as data sources — global table replication means the data is already present in the DR region.

### DynamoDB Gateway VPC Endpoint

A DynamoDB gateway endpoint is provisioned in the VPC so the Lambda can reach DynamoDB without traversing the NAT gateway. Gateway endpoints are free and require no security group — they attach to route tables only.

```hcl
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
```

### Table Definitions

```hcl
# --- Carriers table ---
resource "aws_dynamodb_table" "carriers" {
  count        = var.dr_mode ? 0 : 1
  provider     = aws.active
  name         = "${var.prefix}-mft-carriers"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "carrierId"

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  attribute {
    name = "carrierId"
    type = "S"
  }

  replica {
    region_name = var.dr_region
  }

  tags = merge(local.common_tags, { Name = "${var.prefix}-mft-carriers" })
}

# --- Partners table ---
resource "aws_dynamodb_table" "partners" {
  count        = var.dr_mode ? 0 : 1
  provider     = aws.active
  name         = "${var.prefix}-mft-partners"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "partnerId"

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  attribute {
    name = "partnerId"
    type = "S"
  }

  replica {
    region_name = var.dr_region
  }

  tags = merge(local.common_tags, { Name = "${var.prefix}-mft-partners" })
}

# --- Transfer types table ---
resource "aws_dynamodb_table" "transfer_types" {
  count        = var.dr_mode ? 0 : 1
  provider     = aws.active
  name         = "${var.prefix}-mft-transfer-types"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "transferTypeId"

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  attribute {
    name = "transferTypeId"
    type = "S"
  }

  replica {
    region_name = var.dr_region
  }

  tags = merge(local.common_tags, { Name = "${var.prefix}-mft-transfer-types" })
}

# --- Users table ---
resource "aws_dynamodb_table" "users" {
  count        = var.dr_mode ? 0 : 1
  provider     = aws.active
  name         = "${var.prefix}-mft-users"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "username"

  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

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

  replica {
    region_name = var.dr_region
  }

  tags = merge(local.common_tags, { Name = "${var.prefix}-mft-users" })
}
```

### Table Schema Reference

**`<prefix>-mft-carriers`**

| Attribute | Type | Notes |
|---|---|---|
| `carrierId` | String (PK) | Lower kebab e.g. `acme-mutual` |
| `name` | String | Title Case display name e.g. `Acme Mutual` |
| `status` | String | `active` or `inactive` |
| `createdAt` | String | ISO timestamp |
| `updatedAt` | String | ISO timestamp |

**`<prefix>-mft-partners`**

| Attribute | Type | Notes |
|---|---|---|
| `partnerId` | String (PK) | Lower kebab e.g. `workday` |
| `name` | String | Title Case display name e.g. `Workday` |
| `status` | String | `active` or `inactive` |
| `allowedSourceCidrs` | String | JSON array of CIDR blocks e.g. `["203.0.113.0/24"]`; `["0.0.0.0/0"]` allows any source IP |
| `createdAt` | String | ISO timestamp |
| `updatedAt` | String | ISO timestamp |

**`<prefix>-mft-transfer-types`**

| Attribute | Type | Notes |
|---|---|---|
| `transferTypeId` | String (PK) | Lower kebab e.g. `general-ledger` |
| `name` | String | Title Case display name e.g. `General Ledger` |
| `status` | String | `active` or `inactive` |
| `createdAt` | String | ISO timestamp |
| `updatedAt` | String | ISO timestamp |

**`<prefix>-mft-users`**

| Attribute | Type | Notes |
|---|---|---|
| `username` | String (PK) | Arbitrary lookup key e.g. `sample-ftps-test` — not parsed for routing |
| `carrierId` | String (GSI) | FK to carriers table |
| `partnerId` | String (GSI) | FK to partners table |
| `transferTypeId` | String | FK to transfer types table |
| `env` | String | `p` or `np` |
| `protocol` | String | `ftps`, `sftp`, or `as2` |
| `clientId` | String | Entra app registration client ID (FTPS and SFTP+Entra) |
| `publicKey` | String | SSH public key (SFTP only) |
| `allowedSourceCidrs` | String | Optional JSON CIDR array overriding partner defaults |
| `as2Id` | String | Partner AS2 ID (AS2 only) |
| `as2CertArn` | String | Transfer Family imported certificate ARN (AS2 only) |
| `contactEmail` | String | Partner contact for credential delivery and rotation notifications |
| `internalOwner` | String | TMG staff member accountable for this connection |
| `status` | String (GSI) | `active` or `disabled` |
| `createdAt` | String | ISO timestamp |
| `updatedAt` | String | ISO timestamp |

---

## Sample Resources (`terraform/sample.tf`)

All sample-specific resources are isolated in `terraform/sample.tf`. This file is removed entirely when the carrier and partner onboarding Terraform modules are built in Phase 2. Nothing in `sample.tf` is referenced by production infrastructure.

`sample.tf` contains:
- Three sample IAM session roles (`sample_session_1/2/3`) for FTPS and both SFTP auth modes
- Sample DynamoDB seed data — one carrier, one partner, three transfer types, and three user records with friendly usernames

Note: there is no sample carrier KMS key. The shared S3 bucket uses the default KMS key for all Transfer Family writes regardless of carrier prefix.

```hcl
# =============================================================================
# SAMPLE RESOURCES — Remove this file entirely in Phase 2 when carrier and
# partner onboarding Terraform modules are built.
# =============================================================================

locals {
  sample_timestamp = "2024-01-01T00:00:00Z"
}

# --- Sample DynamoDB seed data ---

resource "aws_dynamodb_table_item" "sample_carrier" {
  count      = var.dr_mode ? 0 : 1
  provider   = aws.active
  table_name = aws_dynamodb_table.carriers[0].name
  hash_key   = "carrierId"

  item = jsonencode({
    carrierId  = { S = "sample-carrier" }
    name       = { S = "Sample Carrier" }
    status     = { S = "active" }
    createdAt  = { S = local.sample_timestamp }
    updatedAt  = { S = local.sample_timestamp }
  })
}

resource "aws_dynamodb_table_item" "sample_partner" {
  count      = var.dr_mode ? 0 : 1
  provider   = aws.active
  table_name = aws_dynamodb_table.partners[0].name
  hash_key   = "partnerId"

  item = jsonencode({
    partnerId  = { S = "sample-partner" }
    name       = { S = "Sample Partner" }
    status     = { S = "active" }
    createdAt  = { S = local.sample_timestamp }
    updatedAt  = { S = local.sample_timestamp }
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

# Sample user records — username is purely a DynamoDB lookup key.
# Role ARN, home directory, and auth config are derived entirely from the
# record fields. Partners can use any username — it has no structural
# requirements and is completely decoupled from the Entra client ID or role.

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

# --- Sample session roles (one per sample user) ---
# Partner onboarding Terraform in Phase 2 will provision one role per
# partner/transfer-type/env following this same pattern.
#
# Role naming convention: mft-<carrierId>.<partnerId>.<transferTypeId>.<env>
# Three roles are seeded: sample_session_1, sample_session_2, sample_session_3
# matching sample-transfer-1/2/3 respectively. See terraform/sample.tf for the
# full policy definitions (S3 prefix scoped to each transfer type, KMS decrypt
# on the default bucket key).

resource "aws_iam_role" "sample_session_1" {
  count    = var.dr_mode ? 0 : 1
  provider = aws.active
  name     = "mft-sample-carrier.sample-partner.sample-transfer-1.np"
  # ... assume_role_policy: transfer.amazonaws.com ...
}
# sample_session_2 and sample_session_3 follow the same pattern for
# sample-transfer-2 and sample-transfer-3.
```

```hcl
resource "aws_iam_role" "transfer_logging" {
  name     = "${var.prefix}-mft-logging"
  provider = aws.active

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "transfer.amazonaws.com" }
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "transfer_logging" {
  role       = aws_iam_role.transfer_logging.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSTransferLoggingAccess"
}
```

### S3 Replication Role

```hcl
resource "aws_iam_role" "replication" {
  name     = "${var.prefix}-mft-replication"
  provider = aws.active

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "s3.amazonaws.com" }
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy" "replication" {
  name     = "${var.prefix}-mft-replication"
  role     = aws_iam_role.replication.id
  provider = aws.active

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetReplicationConfiguration", "s3:ListBucket", "s3:GetEncryptionConfiguration"]
        Resource = "arn:aws:s3:::${local.source_bucket_name}"
      },
      {
        Effect = "Allow"
        Action = ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl",
          "s3:GetObjectVersionTagging"]
        Resource = "arn:aws:s3:::${local.source_bucket_name}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"]
        Resource = "arn:aws:s3:::${local.replica_bucket_name}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:DescribeKey"]
        Resource = local.default_key_active_arn
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
        Resource = local.default_key_passive_arn
      }
    ]
  })
}
```

---

## DR Operational Runbook

`git_repository`, `commit_hash`, and `allowed_cidr_blocks` are injected automatically by Terraflow from environment variables and do not need to be passed on the command line. Only `dr_mode` and `public_hosted_zone_name` are passed explicitly.

### Step 1 — Normal Operations (Primary Mode)

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=<account-id>
export GITHUB_REPOSITORY=<org>/Managed-File-Transfer
export GIT_COMMIT_SHA=$(git rev-parse HEAD)
export ALLOWED_CIDR_BLOCKS='["<your-ip>/32"]'
terraflow apply -- \
  -var="dr_mode=false" \
  -var="public_hosted_zone_name=<your-domain.com>"
```

State written to: `us-east-1-{account-id}-terraform-state/Managed-File-Transfer/terraform.tfstate`

DNS resolves `ftp.<public_hosted_zone_name>` → primary EIPs. CRR replicates primary → DR.

### Step 2 — Disaster Declared (Activate DR)

```bash
export AWS_REGION=us-west-2
export AWS_ACCOUNT_ID=<account-id>
export GITHUB_REPOSITORY=<org>/Managed-File-Transfer
export GIT_COMMIT_SHA=$(git rev-parse HEAD)
export ALLOWED_CIDR_BLOCKS='["<your-ip>/32"]'
terraflow apply -- \
  -var="dr_mode=true" \
  -var="public_hosted_zone_name=<your-domain.com>"
```

State written to: `us-west-2-{account-id}-terraform-state/Managed-File-Transfer/terraform.tfstate`

### Step 3 — Failback (Decommission DR)

```bash
export AWS_REGION=us-west-2
export AWS_ACCOUNT_ID=<account-id>
export GITHUB_REPOSITORY=<org>/Managed-File-Transfer
export GIT_COMMIT_SHA=$(git rev-parse HEAD)
export ALLOWED_CIDR_BLOCKS='["<your-ip>/32"]'
terraflow destroy -- \
  -var="dr_mode=true" \
  -var="public_hosted_zone_name=<your-domain.com>"
```

### Step 4 — Restore Primary

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=<account-id>
export GITHUB_REPOSITORY=<org>/Managed-File-Transfer
export GIT_COMMIT_SHA=$(git rev-parse HEAD)
export ALLOWED_CIDR_BLOCKS='["<your-ip>/32"]'
terraflow apply -- \
  -var="dr_mode=false" \
  -var="public_hosted_zone_name=<your-domain.com>"
```

---

## Outputs (`terraform/outputs.tf`)

```hcl
output "transfer_server_id" {
  description = "Transfer Family server ID"
  value       = aws_transfer_server.mft.id
}

output "transfer_server_endpoint" {
  description = "Transfer Family VPC endpoint internal DNS name"
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
  description = "S3 bucket name currently serving as the SFTP backing store"
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
```

---

## Cross-Stack Reference Convention

The carrier and partner onboarding Terraform modules consume the following SSM parameters published by this module. Because SSM Parameter Store is regional and the onboarding Terraform must work against whichever region is currently active (primary or DR), these parameters are provisioned in both primary and DR mode. Each region's parameters reflect that region's values — `transfer_server_id` differs between primary and DR since they are separate servers.

| Value | SSM Path |
|---|---|
| `transfer_server_id` | `/<prefix>/mft/server-id` |
| `s3_source_bucket` | `/<prefix>/mft/bucket-name` |

The default KMS key ARN is intentionally excluded — carrier onboarding provisions its own carrier-specific KMS key and partner onboarding references the carrier key directly. The default key is only relevant for objects written before any carrier is onboarded and is not needed by onboarding automation.

The partner onboarding Terraform must also provision:
- For FTPS: an Entra ID app registration (client ID and secret), an app role on the Lambda app registration with value matching the IAM role name, assigned to the partner service principal via Graph API
- For SFTP: the partner's SSH public key stored in the DynamoDB users table record
- An IAM session role named `mft-<carrierId>.<partnerId>.<transferTypeId>.<env>` with S3 permissions scoped to both `<bucket>/production/<carrierId>/<partnerId>/<transferTypeId>/*` and `<bucket>/non-production/<carrierId>/<partnerId>/<transferTypeId>/*` and KMS decrypt/generate on the bucket default key
- DynamoDB records in carriers, partners, transfer-types, and users tables as appropriate

---

## State Management

Two independent state files — one per region:

- **Primary state** (`us-east-1`) — owns all infrastructure including S3 buckets, hosted zones, KMS keys, and replica keys. S3 buckets and hosted zones are never touched by DR state.
- **DR state** (`us-west-2`) — owns only the DR region infrastructure (Transfer Family, EIPs, Lambda, ACM cert, security group). References S3 buckets, hosted zones, and KMS keys as data sources.

On DR failback: destroy DR state → re-apply primary state. Primary state detects missing Route 53 records and CRR config and restores them.

---

## Security Considerations

- Transfer Family security group restricts inbound on ports 22, 21, 1024-65535, and 443 to `var.allowed_cidr_blocks`. Default is `0.0.0.0/0` for sandbox — restrict to partner CIDRs in production.
- Authentication delegated to the auth Lambda with DynamoDB-backed routing. Entra client secrets are supplied at connect time. SSH public keys and Entra client IDs are stored in the DynamoDB `users` table; SFTP+SSH auth returns `PublicKeys` for Transfer Family to validate.
- Lambda execution role has minimal permissions — Secrets Manager read on the Entra config secret and CloudWatch Logs write only. No S3 access.
- Session IAM roles returned by Lambda are provisioned by partner onboarding Terraform and scoped to a single carrier/partner/transfer-type S3 prefix. Even a compromised Lambda cannot grant access beyond what these roles permit.
- S3 buckets block all public access. SSE-KMS with customer-managed multi-region keys. Key rotation enabled.
- Transfer Family logs to CloudWatch via dedicated logging role. Lambda logs to CloudWatch with 90-day retention.
- AS2 trading partner authentication via agreements and certificates — configured at partner onboarding time, outside this Terraform.
- Entra config (tenant ID, client ID, client secret) stored as a single JSON secret in AWS Secrets Manager, provisioned and rotated outside this Terraform stack. Not stored in Terraform state at any point.

---

## Implementation Notes for Cursor

1. **`_init.tf` is the only file for provider blocks** — do not place `terraform {}` or `provider` blocks anywhere else.

2. **Locals consolidation** — the main locals block goes in `terraform/locals.tf`. KMS ARN locals may be in a second `locals {}` block in the same file to resolve forward references. No locals blocks in any other file.

3. **VPC data source requires no filter** — one VPC per account/region. Do not add any filter, tag, or `default` attribute. Public subnets are tagged `Type = public` and used for Transfer Family, EIPs, and the S3 gateway endpoint. Private subnets are tagged `Type = private` and used for the Lambda and Secrets Manager VPC endpoint.

4. **Lambda source code and build output** — source lives under `src/main/` and is bundled to `.build/` via `npm run build:lambda`. Terraform zips `.build/lambda/auth` (not `lambda/`).

5. **`address_allocation_ids` and `subnet_ids` alignment** — both must reference `local.public_subnet_ids`. Do not reference `data.aws_subnets.private.ids` directly anywhere.

6. **CRR `depends_on`** — `aws_s3_bucket_replication_configuration` must declare `depends_on` on both versioning resources.

7. **ACM cert ARN** — always reference `aws_acm_certificate_validation.mft.certificate_arn`, never `aws_acm_certificate.mft.arn`.

8. **`allow_overwrite = true`** on both Route 53 records — required for DR failover. Do not remove.

9. **Private Route 53 record is a CNAME** — points at `aws_transfer_server.mft.endpoint`, not at EIPs. Public record is an A record pointing at EIPs. Do not mix these up.

10. **Do not set `invocation_role` on the Transfer Family server when `identity_provider_type = "AWS_LAMBDA"`** — the AWS API rejects servers configured with both. Grant invocation permission via `aws_lambda_permission` with principal `transfer.amazonaws.com` and `source_arn` scoped to the Transfer Family server ARN. `invocation_role` is only valid for `API_GATEWAY` identity providers.

11. **Entra config secret is external** — referenced only via `data "aws_secretsmanager_secret" "entra_config"`. This stack does not create or manage the secret value. The Lambda reads it at runtime via `secretsmanager:GetSecretValue`; the secret name is derived from `var.prefix` and exposed as `local.entra_config_secret`. The secret value must be a JSON object with keys `entra_tenant_id`, `entra_client_id`, `entra_client_secret`.

12. **SSM parameters for cross-stack** — publish `transfer_server_id` and `s3_source_bucket` using path convention `/<prefix>/mft/<key>`. Provision in both primary and DR mode using the `aws.active` provider so each region's state writes its own values. Do not publish `kms_default_key_arn` — it is not needed by carrier or partner onboarding automation.

13. **`commit_hash`, `git_repository`, and `allowed_cidr_blocks`** — injected automatically by Terraflow from environment variables (`GIT_COMMIT_SHA`, `GITHUB_REPOSITORY`, `ALLOWED_CIDR_BLOCKS`). Applied exclusively via `common_tags` for the first two. Not used in any resource name or identifier. Do not add these to command line `-var` arguments.

14. **DynamoDB global tables** — provisioned with `count = var.dr_mode ? 0 : 1`. Each table includes a `replica { region_name = var.dr_region }` block for global table replication. The DynamoDB gateway endpoint is associated with private subnet route tables only — use `data.aws_route_tables.private` not the public route tables.

15. **No `aws_transfer_user` resources** — with `AWS_LAMBDA` identity provider, Transfer Family has no native user objects. All user concerns are handled dynamically by the Lambda response. Do not create any `aws_transfer_user` or `aws_transfer_ssh_key` resources.
