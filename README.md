# Managed File Transfer (MFT) — Active/DR

## Overview

This module provisions a Multi-AZ AWS Transfer Family endpoint speaking **SFTP, FTPS, and AS2**, with active/DR failover across two AWS regions. Files are backed by Amazon S3 with cross-region replication (CRR), encrypted at rest with customer-managed KMS keys, and fronted by a single stable hostname resolved through **split-brain DNS**: a public Route 53 hosted zone serves external partners with an `A` record to the per-AZ Elastic IPs (traffic over the internet), while a private Route 53 hosted zone serves internal consumers with a `CNAME` to the Transfer Family VPC endpoint's internal DNS name (traffic over the VPC, never leaving the private network). Both zones share the same hostname; only the resolved answer differs.

**SFTP and FTPS authentication** is handled by a Lambda identity provider (`AWS_LAMBDA`). On every connect attempt, Transfer Family invokes the auth Lambda, which looks up the username in a DynamoDB `users` table, validates credentials (Entra ID or SSH public key depending on protocol and record configuration), cross-checks Entra JWT `roles` claims against the DynamoDB record on Entra paths, and returns a scoped session IAM role plus logical home directory. **AS2** uses Transfer Family native certificate/agreement configuration and does not invoke the Lambda.

Failover is operated via two independent Terraform state files (one per region) and a `dr_mode` boolean — no cross-state imports are required. All resource names, KMS aliases, IAM role names, S3 bucket names, hostnames, and SSM paths are derived from `var.prefix` and `var.public_hosted_zone_name`; **no organization name is hardcoded anywhere in the module**.

## Architecture Diagram (Primary Mode)

```
 External Partners            Internal Consumers           Microsoft Entra ID
        |                             |                            ^
        | ftp.<zone>                  | ftp.<zone>                 |
        v                             v                            |
 +-------------+            +-------------------+                  |
 | Public R53  |            | Private R53       |                  |
 |  A -> EIPs  |            | CNAME -> Transfer |                  |
 +------+------+            +---------+---------+                  |
        |                             |                            |
        | over Internet               | over VPC                   |
        |                             |                            |
+=======|=============================|============================|=============+
|       v                             |                            |  | PRIMARY  |
|  +---------+                        |                            |  | REGION   |
|  |  EIPs   |--+                     |                            |  |          |
|  +---------+  |                     |                            |  |          |
|               v                     v                            |  |          |
|        +------+---------------------------------+                |  |          |
|        | Transfer Family Server (SFTP/FTPS/AS2) |                |  |          |
|        +------------------+---------------------+                |  |          |
|                           |                                      |  |          |
|                           | SFTP/FTPS auth invoke                |  |          |
|                           v                                      |  |          |
|        +----------------------------------+ HTTPS (Entra token)  |  |          |
|        |  Auth Lambda (private subnets)   +----------------------+  |          |
|        |  src/main/auth/index.ts          |                         |          |
|        +--+------------+--------+---------+                         |          |
|           |            |        |                                   |          |
|           | GetItem    |        | GetSecretValue                    |          |
|           v            |        v                                   |          |
|  +----------------+    |  +----------------------+                  |          |
|  | DynamoDB       |    |  | Secrets Manager      |                  |          |
|  | Global Tables  |    |  | (Entra app config)   |                  |          |
|  | + GW endpoint  |    |  | + interface endpoint |                  |          |
|  | carriers       |    |  +----------------------+                  |          |
|  | partners       |    |                                            |          |
|  | transfer-types |    | Session role returned on success:          |          |
|  | users          |    | mft-<carrier>.<partner>.<transfer>.<env>   |          |
|  +----------------+    |                                            |          |
|                        v                                            |          |
|        +----------------------------------+                         |          |
|        |  S3 Gateway VPC Endpoint         |                         |          |
|        +----------------+-----------------+                         |          |
|                         |                                           |          |
|                         v                                           |          |
|        +----------------------------------+  +-----------------+    |          |
|        |  S3 Primary Bucket               |<-| KMS Default Key |    |          |
|        |  SSE-KMS / Versioned / CRR       |  | alias/<prefix>- |    |          |
|        +----------------------------------+  | mft-default     |    |          |
|                                              +-----------------+    |          |
+================================================|===============================+
                                                 |
                                                 | Cross-Region Replication
                                                 |
+================================================|===============================+
|                                                v                    | DR       |
|                            +----------------------------------+     | REGION   |
|                            |  S3 DR Bucket (replica)          |     |          |
|                            +----------------------------------+     |          |
+================================================================================+
```

Two distinct paths converge on the **same** Transfer Family server:

- **External lane** — public Route 53 returns an `A` record listing the per-AZ EIPs; partners connect over the internet to the EIPs, which are attached to the server via `address_allocation_ids` on the VPC endpoint.
- **Internal lane** — private Route 53 returns a `CNAME` to the server's `endpoint` attribute (e.g. `s-<id>.server.transfer.<region>.amazonaws.com`); VPC DNS resolves that hostname to the server's per-subnet ENIs. Internal traffic never leaves the VPC and never touches an EIP.

The auth Lambda runs in **private subnets** with VPC endpoints for DynamoDB (gateway), Secrets Manager (interface), and outbound HTTPS to Entra ID via NAT for token requests.

In DR mode the topology is mirrored into `var.dr_region`: the Transfer Family server, EIPs, ENIs, security group, S3 gateway endpoint, DynamoDB table replicas, and ACM certificate are re-provisioned there; the public `A` record is overwritten with the DR EIPs and the private `CNAME` is overwritten with the DR Transfer Family endpoint DNS (both via `allow_overwrite = true`); and the replication flow reverses (DR bucket → primary bucket).

## Authentication

This stack uses **Transfer Family `AWS_LAMBDA` identity provider**. There are no `aws_transfer_user` resources — every SFTP/FTPS session is authorized dynamically by the Lambda response.

### Username

The Transfer Family username is the **DynamoDB lookup key** for the `users` table. It can be any string — there is no required format. Partners type this value to connect; role ARN, home directory, Entra client ID, and S3 path are all derived from the DynamoDB record fields, not parsed from the username.

A structured convention such as `<carrierId>.<partnerId>.<transferTypeId>.<env>` is optional and may be used by onboarding automation, but it is not enforced by the Lambda.

### Auth flow

On every SFTP/FTPS connect, Transfer Family invokes the auth Lambda with `{ username, password?, protocol, serverId, sourceIp }`. The Lambda does not read `event.publicKey` — SSH key authentication is delegated to Transfer Family via the `PublicKeys` response field.

1. **Looks up** `username` in DynamoDB (`USERS_TABLE`). Deny (`{}`) if not found.
2. **Checks status** — deny if `status !== "active"`.
3. **Looks up partner** — fetch the `partners` record by `partnerId` from the user record.
4. **Validates source IP** (before any Entra or credential check):
   - Resolve allowed CIDRs: use the user record's `allowedSourceCidrs` when present and non-empty; otherwise use the partner record's `allowedSourceCidrs`.
   - If neither record defines CIDRs, no IP restriction is applied.
   - If the allowlist includes `0.0.0.0/0`, any source IP is permitted.
   - Otherwise `sourceIp` from the event must match at least one CIDR; deny if missing or no match.
5. **Derives session** — `roleArn` and `homeDirectory` from DynamoDB record fields (`carrierId`, `partnerId`, `transferTypeId`, `env`).
6. **Routes by protocol and stored credentials:**

| Protocol | `publicKey` in DynamoDB | Lambda behavior |
|---|---|---|
| `ftps` | n/a | Requires `password`; validates via Entra ID + JWT `roles` claim |
| `sftp` | yes | No password required; returns session + `PublicKeys: [storedKey]`; Transfer Family validates the client key |
| `sftp` | no | Requires `password`; validates via Entra ID + JWT `roles` claim |

7. **Entra paths** — fetch Lambda app config from Secrets Manager (`ENTRA_CONFIG_SECRET`), request a token using the **partner's** `clientId` from the DynamoDB record (not the username), validate JWT audience, then validate the JWT `roles[0]` claim matches the DynamoDB record exactly:

   ```
   mft-<carrierId>.<partnerId>.<transferTypeId>.<env>
   ```

   Neither Entra nor DynamoDB alone is sufficient — both must agree.

8. **On success** — return a Transfer Family authorization response:

   ```json
   {
     "Role": "arn:aws:iam::<account-id>:role/mft-<carrierId>.<partnerId>.<transferTypeId>.<env>",
     "HomeDirectoryType": "LOGICAL",
     "HomeDirectoryDetails": "[{\"Entry\":\"/\",\"Target\":\"/<bucket>/<production|non-production>/<carrierId>/<partnerId>/<transferTypeId>\"}]",
     "PublicKeys": ["ssh-rsa AAAA..."]
   }
   ```

   `PublicKeys` is included only for SFTP users with a stored public key in DynamoDB. `production` maps to `env = p` and `non-production` maps to `env = np`.

### Source IP allowlists

Partner-level CIDRs are stored on the `partners` table as `allowedSourceCidrs` — a JSON string array, e.g. `["203.0.113.0/24","198.51.100.0/24"]`. An optional per-transfer override on the `users` record uses the same attribute name and format. When the user attribute is present with a valid non-empty array, it replaces the partner default; an empty `[]` or invalid value falls back to the partner list.

| Value | Effect |
|---|---|
| Attribute absent on both records | No IP restriction |
| `["0.0.0.0/0"]` | Allow from anywhere |
| Specific CIDRs | `sourceIp` from Transfer Family must match |

This is independent of `var.allowed_cidr_blocks` on the Transfer Family security group, which remains a network perimeter control.

### Verbose logging

Set Terraform variable `auth_verbose_logging = true` (or `VERBOSE_LOGGING=true` on the Lambda directly) to log every authentication request at `INFO` level, including username, protocol, `serverId`, `sourceIp`, and whether a password was supplied. Passwords are never logged. When unset or `false`, only errors are written to CloudWatch Logs.

### DynamoDB schema

Four global tables (replicated to the DR region) store partner routing configuration. The auth Lambda reads the `users` and `partners` tables at connect time; other lookup tables support onboarding and reporting.

```
┌─────────────────────────────┐       ┌────────────────────────────────────────────┐
│  <prefix>-mft-carriers      │       │  <prefix>-mft-partners                     │
├─────────────────────────────┤       ├────────────────────────────────────────────┤
│ PK  carrierId      String   │       │ PK  partnerId          String              │
│     name           String   │       │     name               String              │
│     status         String   │       │     status             String              │
│     createdAt      String   │       │     allowedSourceCidrs String (JSON array) │
│     updatedAt      String   │       │     createdAt          String              │
│                             │       │     updatedAt          String              │
└──────────────┬──────────────┘       └───────────────┬────────────────────────────┘
               │                                      │
               │         ┌────────────────────────────┼────────────────────────────┐
               │         │                            │                            │
               │         │  ┌─────────────────────────▼─────────────────────────┐  │
               │         │  │  <prefix>-mft-transfer-types                      │  │
               │         │  ├───────────────────────────────────────────────────┤  │
               │         │  │ PK  transferTypeId   String                       │  │
               │         │  │     name             String                       │  │
               │         │  │     status           String                       │  │
               │         │  │     createdAt        String                       │  │
               │         │  │     updatedAt        String                       │  │
               │         │  └─────────────────────────┬─────────────────────────┘  │
               │         │                            │                            │
               └─────────┼────────────────────────────┼────────────────────────────┘
                         │                            │
                         │    logical FKs (not enforced by DynamoDB)
                         ▼                            ▼
               ┌─────────────────────────────────────────────────────────────────-┐
               │  <prefix>-mft-users                                              │
               ├─────────────────────────────────────────────────────────────────-┤
               │ PK  username          String                                     │
               │     carrierId         String   ──► carriers.carrierId            │
               │     partnerId         String   ──► partners.partnerId            │
               │     transferTypeId    String   ──► transfer_types.transferTypeId │
               │     env               String   (p | np)                          │
               │     protocol          String   (ftps | sftp | as2)               │
               │     clientId          String   Entra app ID (FTPS / SFTP+Entra)  │
               │     publicKey         String   SSH public key (SFTP+key)         │
               │     allowedSourceCidrs String  Optional CIDR override (JSON)     │
               │     as2Id             String   AS2 partner ID (AS2 only)         │
               │     as2CertArn        String   Transfer cert ARN (AS2 only)      │
               │     contactEmail      String                                     │
               │     internalOwner     String                                     │
               │     status            String   (active | disabled)               │
               │     createdAt         String                                     │
               │     updatedAt         String                                     │
               ├─────────────────────────────────────────────────────────────────-┤
               │ GSI  carrierId-index    (carrierId)                              │
               │ GSI  partnerId-index    (partnerId)                              │
               │ GSI  status-index       (status)                                 │
               └─────────────────────────────────────────────────────────────────-┘
```

Global tables require DynamoDB streams (`NEW_AND_OLD_IMAGES`) for cross-region replication. A gateway VPC endpoint on private subnet route tables allows the Lambda to reach DynamoDB without traversing a NAT gateway.

### Lambda source and build

| Artifact | Path |
|---|---|
| Source | `src/main/auth/index.ts` (with `logger.ts`, `sourceIp.ts`) |
| Tests | `src/test/auth/index.test.ts`, `src/test/auth/sourceIp.test.ts` |
| Build output | `.build/lambda/auth/index.js` |
| Deploy zip | `.build/lambda/auth.zip` |

Run `npm run build:lambda` before `terraflow apply`. The legacy path `lambda/auth/index.mjs` was removed when auth migrated to TypeScript.

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

The `production/` and `non-production/` split lives inside a single bucket; environment isolation is enforced via IAM session roles and the `env` field in DynamoDB, not via separate buckets.

## Prerequisites

- **Terraflow** installed globally — `npm install -g @salte-common/terraflow`.
- **Node.js 18+** and `npm install` in this repo (for Lambda build and tests).
- **VPC with tagged subnets** in *both* the primary and DR regions. Public subnets tagged `Type = public` (Transfer Family, EIPs, S3 gateway endpoint). Private subnets tagged `Type = private` (Lambda, Secrets Manager interface endpoint, DynamoDB gateway endpoint route tables). One VPC per account/region is assumed; the module discovers it via a data source — no `vpc_id` input is required.
- **Public Route 53 hosted zone** pre-provisioned in the target account and referenced by name via `var.public_hosted_zone_name`. The ACM certificate is DNS-validated against this zone.
- **Entra config secret** named `<prefix>/mft/entra` in Secrets Manager (JSON with `entra_tenant_id`, `entra_client_id`, `entra_client_secret`). Provisioned outside this stack.
- **State buckets** named `${AWS_REGION}-${AWS_ACCOUNT_ID}-terraform-state` pre-provisioned in both regions, with a `terraform-statelock` DynamoDB table.
- **`TerraformExecutionRole`** IAM role in the target account, assumable from the caller. Terraflow assumes this role via the `auth.assume_role` block in `.tfwconfig.yml`.

## Variables

Defined in `terraform/inputs.tf`. Terraflow injects several values from environment variables via `.tfwconfig.yml` — see `.env.template` for the full list.

| Variable | Description | Default |
|---|---|---|
| `prefix` | Short identifier used to namespace all resource names, aliases, and tags. | `"salte"` |
| `primary_region` | Primary AWS region for the MFT solution. | `"us-east-1"` |
| `dr_region` | Disaster recovery AWS region. | `"us-west-2"` |
| `dr_mode` | When `true`, provisions DR region infrastructure and reverses replication/DNS. | `false` |
| `eip_count` | Number of EIPs/AZs for the Transfer Family endpoint. Set to `1` in sandbox accounts. | `2` |
| `public_hosted_zone_name` | Public Route 53 hosted zone name (e.g. `your-domain.com`). | **Required** (via env) |
| `allowed_cidr_blocks` | CIDR blocks permitted inbound on ports 22, 21, 1024-65535, and 443. | **Required** (via env) |
| `git_repository` | Git repository name for tagging. | Injected by Terraflow |
| `commit_hash` | Deployment commit hash for tagging. | Injected by Terraflow |
| `sample_ftps_entra_client_id` | Entra client ID for sample FTPS user (`sample-ftps-test`). Seeds DynamoDB. | `""` |
| `sample_sftp_entra_client_id` | Entra client ID for sample SFTP+Entra user (`sample-sftp-entra-test`). Seeds DynamoDB. | `""` |
| `sample_sftp_ssh_public_key` | SSH public key for sample SFTP+SSH user (`sample-sftp-test`). Seeds DynamoDB. | `""` |

## Usage

Set environment variables from `.env.template`, then build the Lambda and apply. The `AWS_REGION` environment variable selects which state bucket is targeted.

```bash
cp .env.template .env   # edit values
export $(grep -v '^#' .env | xargs)
npm run build:lambda
npm test                # optional
```

### 1. Normal operations (primary mode)

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=<account-id>
terraflow apply -- -var="dr_mode=false"
```

State is written to `us-east-1-<account-id>-terraform-state/<git-repo>/terraform.tfstate`. Public DNS resolves `ftp.<zone>` to the primary EIPs (`A`); private DNS resolves the same name to the primary Transfer Family endpoint (`CNAME`). CRR replicates primary → DR. DynamoDB global tables and sample seed data are created in primary mode only.

### 2. Declare disaster (activate DR)

```bash
export AWS_REGION=us-west-2
export AWS_ACCOUNT_ID=<account-id>
terraflow apply -- -var="dr_mode=true"
```

Provisions Transfer Family, EIPs, Lambda, security group, VPC endpoints, and ACM cert in `us-west-2`. Overwrites the public `A` record to the DR EIPs and the private `CNAME` to the DR Transfer Family endpoint DNS. Reverses CRR so the DR bucket replicates back to primary. DynamoDB global table replicas serve reads in the DR region.

### 3. Failback (decommission DR)

```bash
export AWS_REGION=us-west-2
export AWS_ACCOUNT_ID=<account-id>
terraflow destroy -- -var="dr_mode=true"
```

Tears down all DR-region resources. S3 buckets and DynamoDB global tables are referenced as data sources in DR state and are not touched.

### 4. Restore primary

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=<account-id>
terraflow apply -- -var="dr_mode=false"
```

Detects the missing Route 53 records and recreates them — public `A` to primary EIPs, private `CNAME` to the primary Transfer Family endpoint DNS. Restores primary-direction CRR.

## Testing in a Personal Account

`var.public_hosted_zone_name` is the main value to change for a sandbox domain. It propagates through `local.mft_hostname` (`ftp.<zone>`), the ACM certificate, DNS validation records, the private hosted zone, and Route 53 records in both zones.

Populate sample auth values in `.env` so the three sample DynamoDB users can authenticate:

```bash
SAMPLE_FTPS_ENTRA_CLIENT_ID=<ftps-partner-app-client-id>
SAMPLE_SFTP_ENTRA_CLIENT_ID=<sftp-entra-partner-app-client-id>
SAMPLE_SFTP_SSH_PUBLIC_KEY='ssh-rsa AAAA...'
```

Sample usernames (all use env `np` — non-production S3 prefix):

| Username | Protocol | Auth |
|---|---|---|
| `sample-ftps-test` | FTPS | Entra ID |
| `sample-sftp-test` | SFTP | SSH public key |
| `sample-sftp-entra-test` | SFTP | Entra ID |

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=<your-sandbox-account>
export PUBLIC_HOSTED_ZONE_NAME=sandbox.example.dev
export ALLOWED_CIDR_BLOCKS='["203.0.113.42/32"]'
npm run build:lambda
terraflow apply -- -var="dr_mode=false"
```

`var.prefix` defaults to `"salte"` for sandbox use; override it (`-var="prefix=acme"`) to match your organization in non-sandbox accounts.

## Cross-Stack References

Carrier and partner onboarding Terraform modules consume the following SSM parameters published by this module. Resolve them by name to avoid coupling to this module's remote state:

| SSM Path | Value |
|---|---|
| `/<prefix>/mft/server-id` | Transfer Family server ID |
| `/<prefix>/mft/bucket-name` | Active S3 bucket name (primary or DR depending on `dr_mode`) |

Look them up via `data "aws_ssm_parameter"` in downstream modules. Partner onboarding also writes DynamoDB records and provisions session IAM roles named `mft-<carrierId>.<partnerId>.<transferTypeId>.<env>`.

## State Management

Two state files, one per region, owned by the wrapper-driven `${AWS_REGION}-${AWS_ACCOUNT_ID}-terraform-state` backend bucket:

- **Primary state** (`us-east-1` bucket, `dr_mode = false`) — **owns** the primary S3 bucket, DR S3 bucket, KMS default key, DynamoDB global tables, primary Transfer Family server, EIPs, security group, VPC endpoints, primary-direction CRR, public-zone validation records, private hosted zone, and Route 53 records (public `A` → EIPs, private `CNAME` → Transfer endpoint).
- **DR state** (`us-west-2` bucket, `dr_mode = true`) — **owns** the DR Transfer Family server, EIPs, security group, VPC endpoints, ACM cert, DR-direction CRR, private-zone VPC association, and Route 53 records overwriting primary's (public `A` → DR EIPs, private `CNAME` → DR Transfer endpoint). **References** both S3 buckets, DynamoDB tables, and the private hosted zone as `data` sources so `terraform destroy` in DR mode never deletes them.

Sample-only resources (DynamoDB seed items and sample session IAM roles) live in `terraform/sample.tf` and are omitted when `dr_mode = true`.

## Security Notes

- **Inbound exposure** — The Transfer Family security group permits inbound on ports **22 (SFTP)**, **21 + 1024-65535 (FTPS control + passive data)**, and **443 (AS2 over HTTPS)** from `var.allowed_cidr_blocks`. The default of `0.0.0.0/0` is sandbox-only; restrict to partner CIDRs in production. Per-partner and per-transfer `allowedSourceCidrs` in DynamoDB provide an additional auth-layer IP check inside the Lambda.
- **Authentication** — SFTP/FTPS sessions require a valid DynamoDB user record in `active` status, a matching source IP when CIDRs are configured, plus successful credential validation. Entra paths require both a valid token and a matching JWT `roles` claim. SFTP+SSH paths return `PublicKeys` from DynamoDB; Transfer Family performs cryptographic key verification. Entra client secrets are supplied at connect time and are not stored in AWS.
- **S3 hardening** — All S3 buckets enforce `block_public_acls`, `block_public_policy`, `ignore_public_acls`, and `restrict_public_buckets`. Versioning is enabled and non-current versions expire after 90 days.
- **Encryption** — All objects are encrypted with **SSE-KMS** using customer-managed multi-region CMKs. The default key (`alias/<prefix>-mft-default`) encrypts the primary bucket. **Key rotation is enabled** on every CMK.
- **IAM** — Least-privilege roles: `<prefix>-mft-s3-access` (Transfer Family → S3 + KMS), `<prefix>-mft-logging` (Transfer Family → CloudWatch Logs), `<prefix>-mft-replication` (S3 CRR with KMS access on both keys), auth Lambda execution role (`dynamodb:GetItem`, Secrets Manager read, CloudWatch Logs), and per-partner session roles scoped to a single S3 prefix.
- **Logging** — Transfer Family writes session and protocol logs to CloudWatch Logs via the logging role. The auth Lambda logs to `/aws/lambda/<prefix>-mft-auth` with 90-day retention. Set `auth_verbose_logging` (Terraform) or `VERBOSE_LOGGING=true` (Lambda env) to log all auth requests; otherwise only errors are logged.
- **AS2 authentication** — AS2 does **not** use the Transfer Family identity provider. Trading partner agreements, certificates, and connectors are configured per partner during onboarding, outside this module's scope.
