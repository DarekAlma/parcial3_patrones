# =============================================================================
# Backend remoto S3 + Workspaces
#
# Un unico root module y un workspace por ambiente (dev | test | prod).
# Con workspace_key_prefix = "env:" cada workspace guarda su estado en una
# key distinta del bucket versionado:
#
#   s3://aegisvolt-tfstate/env:/dev/aegisvolt/terraform.tfstate
#   s3://aegisvolt-tfstate/env:/test/aegisvolt/terraform.tfstate
#   s3://aegisvolt-tfstate/env:/prod/aegisvolt/terraform.tfstate
#
# Un apply en el workspace "test" solo puede leer/escribir la key de test:
# es imposible que pise el estado de prod.
#
# use_lockfile = true: bloqueo nativo de S3 (archivo .tflock junto al estado)
# para que dos pipelines no apliquen sobre el mismo ambiente a la vez.
# =============================================================================
terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  backend "s3" {
    bucket               = "aegisvolt-tfstate"
    key                  = "aegisvolt/terraform.tfstate"
    workspace_key_prefix = "env:"
    region               = "us-east-1"
    use_lockfile         = true
    encrypt              = true

    # Floci (emulador local). En AWS real se eliminan estas lineas.
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
