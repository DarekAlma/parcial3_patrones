variable "name" {
  description = "Nombre del cluster: <project>-<env>."
  type        = string
}

variable "environment" {
  type = string
}

variable "kubernetes_version" {
  type    = string
  default = "1.33"
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "gateway_endpoint_prefix_list_ids" {
  description = "Prefix lists de los Gateway VPCE (s3, dynamodb) permitidos como salida de los nodos."
  type        = map(string)
  default     = {}
}

variable "public_access_cidrs" {
  description = "CIDRs autorizados al endpoint publico del API server (runner de CI)."
  type        = list(string)
}

variable "service_ipv4_cidr" {
  description = "CIDR de Services de Kubernetes (no debe solaparse con la VPC)."
  type        = string
  default     = "172.20.0.0/16"
}

variable "node_instance_types" {
  type    = list(string)
  default = ["t3.medium"]
}

variable "node_desired_size" {
  type = number
}

variable "node_min_size" {
  type = number
}

variable "node_max_size" {
  type = number
}

variable "workload_namespace" {
  description = "Namespace de Kubernetes donde corren los microservicios."
  type        = string
}

variable "workloads" {
  description = "ServiceAccount => permisos (tablas propias, tablas de solo lectura, log group)."
  type = map(object({
    dynamodb_table_arns  = list(string)
    read_only_table_arns = list(string)
    log_group_arn        = string
  }))
}

variable "tags" {
  type    = map(string)
  default = {}
}
