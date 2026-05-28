# Managed File Transfer (MFT) — Active/DR

## Overview

This module provisions a Multi-AZ AWS Transfer Family endpoint speaking **SFTP, FTPS, and AS2**, with active/DR failover across two AWS regions. Files are backed by Amazon S3 with cross-region replication (CRR), encrypted at rest with customer-managed KMS keys, and fronted by a single stable hostname resolved through **split-brain DNS**: a public Route 53 hosted zone serves external partners with an `A` record to the per-AZ Elastic IPs (traffic over the internet), while a private Route 53 hosted zone serves internal consumers with a `CNAME` to the Transfer Family VPC endpoint's internal DNS name (traffic over the VPC, never leaving the private network). Both zones share the same hostname; only the resolved answer differs.

Failover is operated via two independent Terraform state files (one per region) and a `dr_mode` boolean — no cross-state imports are required. All resource names, KMS aliases, IAM role names, S3 bucket names, hostnames, and SSM paths are derived from `var.prefix` and `var.public_hosted_zone_name`; **no organization name is hardcoded anywhere in the module**.

## Architecture Diagram (Primary Mode)

```
              External Partners                       Internal Consumers
                     |                                         |
                     |  ftp.<zone>                  ftp.<zone> |
                     v                                         v
            +-------------------+                  +----------------------+
            |  Public Route 53  |                  |  Private Route 53    |
            |    A -> EIPs      |                  |    CNAME -> Transfer |
            |                   |                  |    endpoint DNS      |
            +---------+---------+                  +-----------+----------+
                      |                                        |
                      |  over the internet                     |  over the VPC
                      |  to per-AZ EIPs                        |  to ENIs in subnets
                      |                                        |
   +==================|=========== PRIMARY REGION (us-east-1) =|=====================+
   |                  v                                        v                     |
   |              +-------+                              +----------+                |
   |              | EIPs  |--+                       +-->|   ENIs   |                |
   |              +-------+  |                       |   +----------+                |
   |                         v                       v                               |
   |                +-------------------------------------+                          |
   |  ACM cert ---> |    Transfer Family Server           |                          |
   |  ftp.<zone>    |    SFTP  /  FTPS  /  AS2            |                          |
   |                |    endpoint_type = VPC              |                          |
   |                +-----------------+-------------------+                          |
   |                                  |                                              |
   |                                  v                                              |
   |                +-------------------------------------+                          |
   |                |    S3 Gateway VPC Endpoint          |                          |
   |                +-----------------+-------------------+                          |
   |                                  |                                              |
   |                                  v                                              |
   |                +-------------------------------------+   +------------------+   |
   |                |    S3 Primary Bucket                |<--|  KMS Default Key |   |
   |                |    SSE-KMS  /  Versioned            |   |  alias/<prefix>- |   |
   |                +-----------------+-------------------+   |  mft-default     |   |
   |                                  |                       +------------------+   |
   +==================================|==============================================+
                                      |
                                      |  Cross-Region Replication (S3 CRR)
                                      v
   +==================================|====================== DR REGION (us-west-2) =+
   |                                  v                                              |
   |                +-------------------------------------+                          |
   |                |    S3 DR Bucket                     |                          |
   |                |    SSE-KMS  /  Versioned            |                          |
   |                +-------------------------------------+                          |
   +==================================================================================+
```

Two distinct paths converge on the **same** Transfer Family server:

- **External lane** — public Route 53 returns an `A` record listing the per-AZ EIPs; partners connect over the internet to the EIPs, which are attached to the server via `address_allocation_ids` on the VPC endpoint.
- **Internal lane** — private Route 53 returns a `CNAME` to the server's `endpoint` attribute (e.g. `s-<id>.server.transfer.<region>.amazonaws.com`); VPC DNS resolves that hostname to the server's per-subnet ENIs. Internal traffic never leaves the VPC and never touches an EIP.

In DR mode the topology is mirrored into `var.dr_region`: the Transfer Family server, EIPs, ENIs, security group, S3 gateway endpoint, and ACM certificate are re-provisioned there; the public `A` record is overwritten with the DR EIPs and the private `CNAME` is overwritten with the DR Transfer Family endpoint DNS (both via `allow_overwrite = true`); and the replication flow reverses (DR bucket → primary bucket).

## Authentication + Role Naming

This stack uses **Transfer Family `AWS_LAMBDA` identity provider**. The SFTP/FTPS username is the partner’s Entra ID app registration client ID (a GUID) and is **not** used for routing.

The auth Lambda derives authorization from the **JWT `roles` claim** and expects the first role value to be the **exact IAM role name** in AWS:

```
mft-<carrier>.<partner>.<transfer-type>.<env>
```

- **Delimiter**: `.` separates segments (hyphens are allowed inside segment names)
- **Env suffix**: `p` → `production`, `np` → `non-production`

The Lambda uses the role name to derive both:
- **Role ARN**: `arn:aws:iam::<account-id>:role/<roleName>`
- **Home directory**: `/<bucket>/<production|non-production>/<carrier>/<partner>/<transfer-type>`

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

The `production/` and `non-production/` split lives inside a single bucket; environment isolation is enforced via IAM and the username convention, not via separate buckets.

## Prerequisites

- **Terraflow** installed globally — `npm install -g @salte-common/terraflow`.
- **VPC with private subnets** pre-provisioned in *both* the primary and DR regions. Minimum two AZs in each region for Multi-AZ EIP placement. Subnet IDs are passed in via `var.private_subnet_ids` or discovered via the `Tier=Private` tag if `var.lookup_subnets_by_tag = true`.
- **Public Route 53 hosted zone** pre-provisioned in the target account and referenced by name via `var.public_hosted_zone_name`. The ACM certificate is DNS-validated against this zone.
- **State buckets** named `${AWS_REGION}-${AWS_ACCOUNT_ID}-terraform-state` pre-provisioned in both regions, with a `terraform-statelock` DynamoDB table.
- **`TerraformExecutionRole`** IAM role in the target account, assumable from the caller. Terraflow assumes this role via the `auth.assume_role` block in `.tfwconfig.yml`.

## Variables

Defined in `terraform/inputs.tf`. Variables marked **Required** have no default and must be supplied at apply time.

| Variable | Description | Default |
|---|---|---|
| `prefix` | Short identifier used to namespace all resource names, aliases, and tags. Override to match your organization. | `"salte"` |
| `primary_region` | Primary AWS region for the MFT solution. | `"us-east-1"` |
| `dr_region` | Disaster recovery AWS region. | `"us-west-2"` |
| `dr_mode` | When `true`, provisions DR region infrastructure and reverses replication/DNS. When `false`, provisions primary region infrastructure. | `false` |
| `vpc_id` | ID of the pre-provisioned VPC in the active region. | **Required** |
| `private_subnet_ids` | List of private subnet IDs in the active region VPC (minimum 2 for Multi-AZ). | **Required** |
| `environment` | Environment label applied to tags (e.g. `prod`, `nonprod`). | `"prod"` |
| `public_hosted_zone_name` | Public Route 53 hosted zone name (e.g. `your-domain.com`). Must be pre-provisioned. | **Required** |
| `private_hosted_zone_name_override` | Optional override for the private Route 53 hosted zone name. Defaults to `public_hosted_zone_name`. | `null` |
| `sftp_hostname_override` | Optional override for the SFTP public hostname. Defaults to `ftp.<public_hosted_zone_name>`. | `null` |
| `s3_primary_bucket_name_override` | Optional override for the primary S3 bucket name. Defaults to `<prefix>-mft-primary`. | `null` |
| `s3_dr_bucket_name_override` | Optional override for the DR S3 bucket name. Defaults to `<prefix>-mft-dr`. | `null` |
| `lookup_subnets_by_tag` | When `true`, private subnets are looked up by `Tier=Private` instead of using `private_subnet_ids`. | `false` |
| `allowed_cidr_blocks` | CIDR blocks permitted inbound on ports 22, 21, 1024-65535, and 443. | `["0.0.0.0/0"]` |
| (removed) `sample_carrier_user_public_key` | No longer used (AWS_LAMBDA identity provider; no Transfer Family native users). | — |

## Usage

The full DR lifecycle is operated through four `terraflow` invocations. The `AWS_REGION` environment variable selects which state bucket is targeted.

### 1. Normal operations (primary mode)

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=<account-id>
terraflow apply -- -var="dr_mode=false" \
  -var="vpc_id=<primary-vpc-id>" \
  -var="private_subnet_ids=[\"<subnet-1>\",\"<subnet-2>\"]" \
  -var="public_hosted_zone_name=<your-domain.com>"
```

State is written to `us-east-1-<account-id>-terraform-state/<prefix>-mft-transfer/terraform.tfstate`. Public DNS resolves `ftp.<zone>` to the primary EIPs (`A`); private DNS resolves the same name to the primary Transfer Family endpoint (`CNAME`). CRR replicates primary → DR.

### 2. Declare disaster (activate DR)

```bash
export AWS_REGION=us-west-2
export AWS_ACCOUNT_ID=<account-id>
terraflow apply -- -var="dr_mode=true" \
  -var="vpc_id=<dr-vpc-id>" \
  -var="private_subnet_ids=[\"<dr-subnet-1>\",\"<dr-subnet-2>\"]" \
  -var="public_hosted_zone_name=<your-domain.com>"
```

Provisions Transfer Family, EIPs, security group, VPC endpoint, and ACM cert in `us-west-2`. Overwrites the public `A` record to the DR EIPs and the private `CNAME` to the DR Transfer Family endpoint DNS (`allow_overwrite = true` on both). Reverses CRR so the DR bucket replicates back to primary.

### 3. Failback (decommission DR)

```bash
export AWS_REGION=us-west-2
export AWS_ACCOUNT_ID=<account-id>
terraflow destroy -- -var="dr_mode=true" \
  -var="vpc_id=<dr-vpc-id>" \
  -var="private_subnet_ids=[\"<dr-subnet-1>\",\"<dr-subnet-2>\"]" \
  -var="public_hosted_zone_name=<your-domain.com>"
```

Tears down all DR-region resources. S3 buckets are referenced as data sources in DR state and are not touched.

### 4. Restore primary

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=<account-id>
terraflow apply -- -var="dr_mode=false" \
  -var="vpc_id=<primary-vpc-id>" \
  -var="private_subnet_ids=[\"<subnet-1>\",\"<subnet-2>\"]" \
  -var="public_hosted_zone_name=<your-domain.com>"
```

Detects the missing Route 53 records and recreates them — public `A` to primary EIPs, private `CNAME` to the primary Transfer Family endpoint DNS. Restores primary-direction CRR. Primary operations resume.

## Testing in a Personal Account

`var.public_hosted_zone_name` is the **only** value that needs to change to point the stack at a personal sandbox domain. Setting it propagates automatically through `local.sftp_hostname` (`ftp.<zone>`), the ACM certificate, the DNS-validation records, the private hosted zone name, and the Route 53 records in both zones (the public `A` and the private `CNAME`). No other variable needs to be overridden.

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=<your-sandbox-account>
terraflow apply -- \
  -var="vpc_id=vpc-0123456789abcdef0" \
  -var="private_subnet_ids=[\"subnet-aaa\",\"subnet-bbb\"]" \
  -var="public_hosted_zone_name=sandbox.example.dev" \
  -var="allowed_cidr_blocks=[\"203.0.113.42/32\"]"
```

`var.prefix` defaults to `"salte"` for sandbox use; override it (`-var="prefix=acme"`) to match your organization in non-sandbox accounts.

## Cross-Stack References

Carrier and partner onboarding Terraform modules consume the following SSM parameters published by this module. Resolve them by name to avoid coupling to this module's remote state:

| SSM Path | Value |
|---|---|
| `/<prefix>/mft/server-id` | `aws_transfer_server.mft.id` |
| `/<prefix>/mft/bucket-name` | `local.source_bucket_name` (the active bucket — primary or DR depending on `dr_mode`) |
| (removed) `/<prefix>/mft/kms/default-key-arn` | No longer published; onboarding does not need the default KMS key ARN. | — |

Look them up via `data "aws_ssm_parameter"` in downstream modules.

## State Management

Two state files, one per region, owned by the wrapper-driven `${AWS_REGION}-${AWS_ACCOUNT_ID}-terraform-state` backend bucket:

- **Primary state** (`us-east-1` bucket, `dr_mode = false`) — **owns** the primary S3 bucket, DR S3 bucket, KMS default key, primary Transfer Family server, EIPs, security group, VPC endpoint, primary-direction CRR, public-zone validation records, private hosted zone, and Route 53 records (public `A` → EIPs, private `CNAME` → Transfer endpoint).
- **DR state** (`us-west-2` bucket, `dr_mode = true`) — **owns** the DR Transfer Family server, EIPs, security group, VPC endpoint, ACM cert, DR-direction CRR, private-zone VPC association, and Route 53 records overwriting primary's (public `A` → DR EIPs, private `CNAME` → DR Transfer endpoint). **References** both S3 buckets and the private hosted zone as `data` sources so `terraform destroy` in DR mode never deletes them.

No sample-carrier KMS key is provisioned by this stack anymore. Sample-only IAM resources live in `terraform/sample.tf` and can be deleted entirely in Phase 2.

## Security Notes

- **Inbound exposure** — The Transfer Family security group permits inbound on ports **22 (SFTP)**, **21 + 1024-65535 (FTPS control + passive data)**, and **443 (AS2 over HTTPS)** from `var.allowed_cidr_blocks`. The default of `0.0.0.0/0` is sandbox-only; restrict to partner CIDRs in production.
- **S3 hardening** — All S3 buckets enforce `block_public_acls`, `block_public_policy`, `ignore_public_acls`, and `restrict_public_buckets`. Versioning is enabled and non-current versions expire after 90 days.
- **Encryption** — All objects are encrypted with **SSE-KMS** using customer-managed CMKs. The default key (`alias/<prefix>-mft-default`) encrypts the primary bucket; per-carrier CMKs (`alias/<prefix>-mft-sample-carrier` and analogues added during onboarding) scope key access by carrier. **Key rotation is enabled** on every CMK.
- **IAM** — Three least-privilege roles: `<prefix>-mft-s3-access` (Transfer Family → S3 + KMS), `<prefix>-mft-logging` (Transfer Family → CloudWatch Logs via the AWS-managed `AWSTransferLoggingAccess` policy), and `<prefix>-mft-replication` (S3 CRR with KMS access on both source and destination keys).
- **Logging** — Transfer Family writes session and protocol logs to CloudWatch Logs via the logging role. Enable S3 server access logging by attaching a separate audit log bucket — this is intentionally provisioned outside this module.
- **AS2 authentication** — AS2 does **not** use the Transfer Family identity provider. Trading partner agreements, certificates, and connectors are configured per partner during onboarding, outside this module's scope. The security group restricts who can reach the AS2 endpoint in the first place.
