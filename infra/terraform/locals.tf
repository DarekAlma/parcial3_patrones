# =============================================================================
# El ambiente SE DERIVA DEL WORKSPACE, no de una variable editable.
# Asi el nombre de cada recurso queda atado a ${terraform.workspace}:
#   workspace dev  -> aegisvolt-reservations-dev,  /aegisvolt/dev/...
#   workspace prod -> aegisvolt-reservations-prod, /aegisvolt/prod/...
# Dos workspaces nunca producen el mismo nombre => no hay colisiones.
# =============================================================================
locals {
  environment = terraform.workspace
  name_prefix = "${var.project}-${local.environment}"

  # Microservicios + capa GraphQL (orquestador de la SAGA)
  services = [
    "station-reservation-service",
    "billing-wallet-service",
    "energy-dispatch-service",
    "graphql-gateway",
  ]

  # Database-per-Service: una tabla por servicio y por ambiente.
  tables = {
    reservations = {
      service       = "station-reservation-service"
      ttl_attribute = "expiresAt" # bloqueo temporal de bahias
      attributes    = { pk = "S", sk = "S", gsi1pk = "S", gsi1sk = "S" }
      gsis          = [{ name = "gsi1", hash_key = "gsi1pk", range_key = "gsi1sk" }]
    }
    billing = {
      service       = "billing-wallet-service"
      ttl_attribute = null
      attributes    = { pk = "S", sk = "S" }
      gsis          = []
    }
    dispatch = {
      service       = "energy-dispatch-service"
      ttl_attribute = "expiresAt" # retencion de telemetria
      attributes    = { pk = "S", sk = "S" }
      gsis          = []
    }
    saga = {
      service       = "graphql-gateway"
      ttl_attribute = null
      attributes    = { pk = "S", sk = "S", gsi1pk = "S", gsi1sk = "S" }
      gsis          = [{ name = "gsi1", hash_key = "gsi1pk", range_key = "gsi1sk" }] # por estado
    }
  }
}

# Guarda de seguridad: el workspace "default" (u otro) no puede desplegar nada.
resource "terraform_data" "workspace_guard" {
  input = local.environment

  lifecycle {
    precondition {
      condition     = contains(["dev", "test", "prod"], terraform.workspace)
      error_message = "Workspace '${terraform.workspace}' invalido. Use: terraform workspace select dev|test|prod."
    }
    precondition {
      condition     = var.expected_environment == terraform.workspace
      error_message = "El tfvars es de '${var.expected_environment}' pero el workspace activo es '${terraform.workspace}'."
    }
  }
}
