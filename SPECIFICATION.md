# MFT (Managed File Transfer) — Cursor Implementation Spec

## Overview

This spec instructs Cursor to implement an AWS Transfer Family MFT solution (SFTP/FTPS/AS2) scaffolded with Terraflow, designed for active/DR operation across two AWS regions. The solution supports a clean DR failover and failback workflow using two independent Terraform state files — one per region — with no cross-state imports required.

Authentication is delegated to Entra ID via a Lambda identity provider. Transfer Family invokes the Lambda directly for every FTPS and SFTP connection. The Lambda validates partner credentials against Entra ID using the OAuth2 client credentials flow, then derives the home directory and session IAM role from the `roles` claim in the returned token — no database required.

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
- **Lambda Auth Broker** — Node.js Lambda function provisioned in **private subnets** with VPC config, invoked directly by Transfer Family for every SFTP and FTPS authentication attempt. Validates partner credentials against Entra ID using the OAuth2 client credentials flow with `.default` scope. Reads the `roles` claim from the returned token to derive the IAM session role and home directory. Returns authorization response to Transfer Family.
- **Lambda Security Group** — Allows outbound HTTPS (443) only, for Entra ID token endpoint calls via NAT gateway.
- **Secrets Manager VPC Endpoint** — Interface endpoint in private subnets with private DNS enabled. Allows Lambda to reach Secrets Manager without traversing the NAT gateway. Dedicated security group allowing inbound 443 from the Lambda security group only.
- **Secrets Manager VPC Endpoint Security Group** — Inbound 443 from Lambda security group only.
- **Secrets Manager Secret (Entra Config)** — Referenced as a data source. Holds a JSON object with `entra_tenant_id`, `entra_client_id`, and `entra_client_secret`. Provisioned outside this Terraform stack by a separate secrets management process. The Lambda reads it at runtime; this stack only grants `secretsmanager:GetSecretValue` on its ARN.
- **CloudWatch Log Group (Lambda)** — Retention 90 days.
- **VPC Endpoint (S3 Gateway)** — S3 gateway endpoint in the VPC, associated with route tables in the private subnets.
- **KMS Key (Default)** — Multi-region CMK used as the bucket default encryption key. Primary alias: `alias/<prefix>-mft-default`. Replica key with same alias in DR region. Primary mode only.
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

The Lambda is the authentication integration point between Transfer Family and Entra ID. It is the only component in this architecture that handles credentials — and only transiently, for the duration of a single auth call. No credentials are stored anywhere in AWS.

### Authentication Flow

1. Partner's FTPS/SFTP client sends their Entra ID app registration client ID as username and client secret as password
2. Transfer Family invokes the Lambda with a JSON event containing `username`, `password`, `serverId`, `protocol`, and `sourceIp`
3. Lambda fetches the Entra config (`entra_tenant_id`, `entra_client_id`, `entra_client_secret`) from AWS Secrets Manager
4. Lambda calls the Entra ID token endpoint using the partner's credentials with scope `api://<entra_client_id>/.default` — the `.default` suffix is required by Entra ID for client credentials flow against custom APIs
5. Entra ID validates the credentials and returns a JWT if valid
6. Lambda validates the JWT audience claim against `api://<entra_client_id>`
7. Lambda reads the `roles` claim from the token — this contains the IAM role name assigned to this partner in Entra ID (e.g. `mft-sample-carrier.sample-partner.sample-transfer.np`)
8. Lambda uses the role name directly as the IAM role name and parses it to derive the home directory
9. Lambda returns the authorization response to Transfer Family

### Role Name Convention and Derivation

The IAM role name is carried in the `roles` claim of the Entra ID token. It is defined as an app role on the Lambda app registration and assigned to each partner app registration. The role name directly matches the IAM role name in AWS — no translation needed.

Role name format: `mft-<carrier>.<partner>.<transfer-type>.<env>`

The `.` character is used as the segment delimiter between carrier, partner, transfer type, and environment. Hyphens `-` are reserved for use within segment names (e.g. `sample-carrier`, `general-ledger`). This makes parsing unambiguous regardless of how many hyphens appear within a segment name.

Environment suffix mapping:

| Role name suffix | S3 folder |
|---|---|
| `p` | `production` |
| `np` | `non-production` |

Derived values from role name `mft-acme.workday.personnel.p`:

| Value | Result |
|---|---|
| IAM role name | `mft-acme.workday.personnel.p` |
| IAM role ARN | `arn:aws:iam::<account-id>:role/mft-acme.workday.personnel.p` |
| Home directory | `/<bucket>/production/acme/workday/personnel` |

Parsing logic — given role name `mft-<carrier>.<partner>.<transfer-type>.<env>`:
- Strip leading `mft-`
- Split remainder on `.`
- Last segment → environment (`p` or `np`)
- Second to last → transfer type
- Third to last → partner
- Everything remaining → carrier (joined with `.` if multi-segment, though carriers should be single segment)

The session role is provisioned by the partner onboarding Terraform. Its S3 permissions are scoped to both the production and non-production prefixes for that carrier/partner/transfer-type — environment isolation is enforced by the home directory mapping returned by the Lambda, not by IAM.

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
  description      = "Transfer Family identity provider — validates partner credentials against Entra ID and derives session role and home directory from token roles claim"
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

Note: `PREFIX` is no longer needed as an environment variable — the IAM role name is derived entirely from the token `roles` claim, not constructed from the prefix.

### Lambda Source Code and Build

Authoritative source code lives under `src/main/` and tests under `src/test/` (mirrored folder structure). The deployable Lambda artifact is a bundled JavaScript file generated into `.build/` and packaged by Terraform.

- **Source**: `src/main/auth/index.ts`
- **Tests**: `src/test/auth/index.test.ts`
- **Build output**: `.build/lambda/auth/index.js` (generated by `npm run build:lambda`)
- **Zip output**: `.build/lambda/auth.zip` (generated by Terraform `archive_file`)

The auth logic must implement the following:

```javascript
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const secrets = new SecretsManagerClient({});

// Role name environment suffix → S3 folder mapping
const ENV_FOLDER_MAP = {
  p: "production",
  np: "non-production",
};

export const handler = async (event, context) => {
  const { username, password } = event;

  try {
    if (!username || !password) {
      console.error("Missing username or password");
      return {};
    }

    // 1. Fetch the Entra config from Secrets Manager at runtime. We
    // intentionally do not cache between invocations — rotations in Secrets
    // Manager take effect immediately. The secret is a JSON object with keys
    // entra_tenant_id, entra_client_id, entra_client_secret and is provisioned
    // outside this Terraform stack.
    const secretId = process.env.ENTRA_CONFIG_SECRET;
    const secretResponse = await secrets.send(
      new GetSecretValueCommand({ SecretId: secretId }),
    );
    const {
      entra_tenant_id,
      entra_client_id,
      entra_client_secret,
    } = JSON.parse(secretResponse.SecretString);

    // 2. Validate partner credentials against Entra ID token endpoint.
    // The .default suffix is required by Entra ID for client credentials
    // flow against custom APIs — named scopes are not supported in this flow.
    const scope = `api://${entra_client_id}/.default`;
    const tokenUrl = `https://login.microsoftonline.com/${entra_tenant_id}/oauth2/v2.0/token`;

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: username,        // Partner's Entra ID app registration client ID
      client_secret: password,    // Partner's Entra ID app registration client secret
      scope,
    });

    const tokenResponse = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!tokenResponse.ok) {
      console.error(`Entra ID auth failed for ${username}: ${tokenResponse.status}`);
      return {};
    }

    const tokenData = await tokenResponse.json();

    // 3. Decode and validate JWT audience claim. Signature verification is
    // provided by the TLS channel to the Entra ID token endpoint.
    const [, payloadB64] = tokenData.access_token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());

    const expectedAudience = `api://${entra_client_id}`;
    if (payload.aud !== expectedAudience) {
      console.error(`Invalid token audience: ${payload.aud}`);
      return {};
    }

    // 4. Read the IAM role name from the roles claim.
    // The roles claim contains the app role value assigned to this partner
    // in Entra ID, which exactly matches the IAM role name in AWS.
    // Format: mft-<carrier>.<partner>.<transfer-type>.<env>
    if (!payload.roles || payload.roles.length === 0) {
      console.error(`No roles claim in token for ${username}`);
      return {};
    }

    const roleName = payload.roles[0];
    console.log(`Authenticated ${username} → role: ${roleName}`);

    // 5. Parse role name to derive home directory.
    // Strip leading "mft-" then split on "." — dots are the segment
    // delimiter between carrier, partner, transfer-type, and env.
    // Hyphens within segment names are preserved correctly with this approach.
    const roleWithoutPrefix = roleName.replace(/^mft-/, "");
    const parts = roleWithoutPrefix.split(".");

    if (parts.length < 4) {
      console.error(`Invalid role name format: ${roleName}`);
      return {};
    }

    const env = parts[parts.length - 1];
    const transferType = parts[parts.length - 2];
    const partner = parts[parts.length - 3];
    const carrier = parts.slice(0, parts.length - 3).join(".");

    const s3Folder = ENV_FOLDER_MAP[env];
    if (!s3Folder) {
      console.error(`Unknown environment suffix in role name: ${env}`);
      return {};
    }

    // 6. Construct role ARN and home directory.
    // Account ID is extracted from the Lambda's own invoked ARN since
    // Lambda runtime does not expose AWS_ACCOUNT_ID as an env var.
    const accountId = context.invokedFunctionArn.split(":")[4];
    const bucket = process.env.S3_BUCKET_NAME;

    const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
    const homeDirectory = `/${bucket}/${s3Folder}/${carrier}/${partner}/${transferType}`;

    // 7. Return Transfer Family authorization response
    return {
      Role: roleArn,
      HomeDirectoryType: "LOGICAL",
      HomeDirectoryDetails: JSON.stringify([
        { Entry: "/", Target: homeDirectory },
      ]),
    };

  } catch (err) {
    console.error("Auth Lambda error:", err);
    return {};  // Return empty object to deny access on any error
  }
};
```

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

## Sample Resources (`terraform/sample.tf`)

All sample-specific resources are isolated in `terraform/sample.tf`. This file is removed entirely when the carrier and partner onboarding Terraform modules are built in Phase 2. Nothing in `sample.tf` is referenced by production infrastructure.

`sample.tf` contains the sample partner session role — demonstrating the full partner onboarding pattern that Phase 2 will automate.

Note: there is no sample carrier KMS key. The shared S3 bucket uses the default KMS key for all Transfer Family writes regardless of carrier prefix. Per-carrier KMS keys are not relevant to the Transfer Family write path.

```hcl
# =============================================================================
# SAMPLE RESOURCES — Remove this file entirely in Phase 2 when carrier and
# partner onboarding Terraform modules are built.
# =============================================================================

# --- Sample partner session role ---
# Demonstrates the partner session role pattern. Partner onboarding Terraform
# in Phase 2 will provision one role per partner/transfer-type/env following
# this same pattern.
#
# Role naming convention: mft-<carrier>.<partner>.<transfer-type>.<env>
# - mft- prefix
# - . as segment delimiter between carrier, partner, transfer type, environment
# - - within segment names for multi-word values
# - np for non-production, p for production

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
        Action   = ["s3:GetReplicationConfiguration", "s3:ListBucket"]
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
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = local.default_key_active_arn
      },
      {
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
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
- An Entra ID app registration for the partner (client ID and secret)
- An app role on the Lambda app registration with value matching the IAM role name: `mft-<carrier>.<partner>.<transfer-type>.<env>` where env is `p` (production) or `np` (non-production)
- Assign that app role to the partner's service principal via Graph API
- An IAM session role named `mft-<carrier>.<partner>.<transfer-type>.<env>` with S3 permissions scoped to both `<bucket>/production/<carrier>/<partner>/<transfer-type>/*` and `<bucket>/non-production/<carrier>/<partner>/<transfer-type>/*` and KMS decrypt/generate on the **bucket default key** (Transfer Family always writes using the bucket default key)

---

## State Management

Two independent state files — one per region:

- **Primary state** (`us-east-1`) — owns all infrastructure including S3 buckets, hosted zones, KMS keys, and replica keys. S3 buckets and hosted zones are never touched by DR state.
- **DR state** (`us-west-2`) — owns only the DR region infrastructure (Transfer Family, EIPs, Lambda, ACM cert, security group). References S3 buckets, hosted zones, and KMS keys as data sources.

On DR failback: destroy DR state → re-apply primary state. Primary state detects missing Route 53 records and CRR config and restores them.

---

## Security Considerations

- Transfer Family security group restricts inbound on ports 22, 21, 1024-65535, and 443 to `var.allowed_cidr_blocks`. Default is `0.0.0.0/0` for sandbox — restrict to partner CIDRs in production.
- Authentication delegated entirely to Entra ID. No partner credentials stored in AWS.
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

14. **No `aws_transfer_user` resources** — with `AWS_LAMBDA` identity provider, Transfer Family has no native user objects. All user concerns are handled dynamically by the Lambda response. Do not create any `aws_transfer_user` or `aws_transfer_ssh_key` resources.
