terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {}
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
