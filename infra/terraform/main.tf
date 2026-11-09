# =============================================================================
# AegisVolt - Root module (un solo codigo, tres workspaces: dev | test | prod)
# =============================================================================

module "network" {
  source = "./modules/network"

  project                     = var.project
  environment                 = local.environment
  name_prefix                 = local.name_prefix
  region                      = var.region
  cidr                        = var.vpc_cidr
  azs                         = var.azs
  interface_endpoint_services = var.interface_endpoint_services
}

module "tables" {
  source   = "./modules/dynamodb"
  for_each = local.tables

  name                     = "${var.project}-${each.key}-${local.environment}"
  service                  = each.value.service
  attributes               = each.value.attributes
  global_secondary_indexes = each.value.gsis
  ttl_attribute            = each.value.ttl_attribute
  point_in_time_recovery   = var.dynamodb_pitr
  deletion_protection      = var.dynamodb_deletion_protection
}

module "feature_flags" {
  source = "./modules/feature-flags"

  project             = var.project
  environment         = local.environment
  flags               = var.feature_flags
  deletion_protection = var.dynamodb_deletion_protection
}

module "observability" {
  source = "./modules/observability"

  project                   = var.project
  environment               = local.environment
  services                  = local.services
  saga_orchestrator_service = "graphql-gateway"
  log_retention_days        = var.log_retention_days
  canary_error_threshold    = var.canary_error_threshold
}

module "eks" {
  source = "./modules/eks"

  name                             = local.name_prefix
  environment                      = local.environment
  kubernetes_version               = var.kubernetes_version
  vpc_id                           = module.network.vpc_id
  vpc_cidr                         = module.network.vpc_cidr
  private_subnet_ids               = module.network.private_subnet_ids
  gateway_endpoint_prefix_list_ids = module.network.gateway_endpoint_prefix_list_ids
  public_access_cidrs              = var.eks_public_access_cidrs
  node_instance_types              = var.node_instance_types
  node_desired_size                = var.node_desired_size
  node_min_size                    = var.node_min_size
  node_max_size                    = var.node_max_size
  workload_namespace               = var.project

  # Least privilege: cada ServiceAccount solo escribe en su propia tabla.
  workloads = {
    "station-reservation-service" = {
      dynamodb_table_arns  = [module.tables["reservations"].arn]
      read_only_table_arns = [module.feature_flags.table_arn]
      log_group_arn        = "arn:aws:logs:${var.region}:*:log-group:${module.observability.log_groups["station-reservation-service"]}"
    }
    "billing-wallet-service" = {
      dynamodb_table_arns  = [module.tables["billing"].arn]
      read_only_table_arns = [module.feature_flags.table_arn]
      log_group_arn        = "arn:aws:logs:${var.region}:*:log-group:${module.observability.log_groups["billing-wallet-service"]}"
    }
    "energy-dispatch-service" = {
      dynamodb_table_arns  = [module.tables["dispatch"].arn]
      read_only_table_arns = [module.feature_flags.table_arn]
      log_group_arn        = "arn:aws:logs:${var.region}:*:log-group:${module.observability.log_groups["energy-dispatch-service"]}"
    }
    "graphql-gateway" = {
      dynamodb_table_arns  = [module.tables["saga"].arn, module.feature_flags.table_arn]
      read_only_table_arns = []
      log_group_arn        = "arn:aws:logs:${var.region}:*:log-group:${module.observability.log_groups["graphql-gateway"]}"
    }
  }
}

module "api_gateway" {
  source = "./modules/api-gateway"

  name                   = local.name_prefix
  environment            = local.environment
  vpc_id                 = module.network.vpc_id
  vpc_cidr               = module.network.vpc_cidr
  private_subnet_ids     = module.network.private_subnet_ids
  node_security_group_id = module.eks.node_security_group_id
  node_port              = var.graphql_node_port
  nlb_listener_port      = var.nlb_listener_port
  cors_allow_origins     = var.cors_allow_origins
  throttling_burst_limit = var.api_throttling_burst_limit
  throttling_rate_limit  = var.api_throttling_rate_limit
  access_log_group_arn   = module.observability.api_gateway_log_group_arn
  enable_private_api     = var.enable_private_api
  execute_api_vpce_id    = module.network.execute_api_vpce_id
}
