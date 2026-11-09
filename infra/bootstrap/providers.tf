terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # El estado del bootstrap tambien vive en el bucket que crea (tras la migracion).
  backend "s3" {
    bucket                      = "aegisvolt-tfstate"
    key                         = "bootstrap/terraform.tfstate"
    region                      = "us-east-1"
    use_lockfile                = true
    encrypt                     = true
    use_path_style              = true
    skip_credentials_validation = true
    skip_requesting_account_id  = true
    skip_region_validation      = true
    skip_metadata_api_check     = true
    endpoints = {
      s3 = "http://localhost:4566"
    }
  }
}

provider "aws" {
  region                      = var.region
  s3_use_path_style           = var.aws_endpoint != null
  skip_credentials_validation = var.aws_endpoint != null
  skip_requesting_account_id  = var.aws_endpoint != null
  skip_metadata_api_check     = var.aws_endpoint != null

  # Floci: todos los servicios en el mismo endpoint. Con aws_endpoint = null
  # el provider usa los endpoints reales de AWS.
  dynamic "endpoints" {
    for_each = var.aws_endpoint == null ? [] : [var.aws_endpoint]
    content {
      s3  = endpoints.value
      sts = endpoints.value
    }
  }
}
