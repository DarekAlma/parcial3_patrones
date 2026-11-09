output "environment" {
  value = local.environment
}

output "vpc_id" {
  value = module.network.vpc_id
}

output "private_subnet_ids" {
  value = module.network.private_subnet_ids
}

output "vpc_endpoints" {
  value = merge(module.network.gateway_endpoint_ids, module.network.interface_endpoint_ids)
}

output "dynamodb_tables" {
  value = merge(
    { for k, t in module.tables : k => t.name },
    { feature_flags = module.feature_flags.table_name },
  )
}

output "log_groups" {
  value = module.observability.log_groups
}

output "eks_cluster_name" {
  value = module.eks.cluster_name
}

output "eks_cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "workload_role_arns" {
  value = module.eks.workload_role_arns
}

output "api_endpoint" {
  value = module.api_gateway.public_api_endpoint
}

output "api_id" {
  value = module.api_gateway.public_api_id
}

output "nlb_target_group_arn" {
  value = module.api_gateway.target_group_arn
}

output "private_api_invoke_url" {
  value = module.api_gateway.private_api_invoke_url
}
