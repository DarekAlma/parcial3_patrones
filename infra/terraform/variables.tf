variable "project" {
  type    = string
  default = "aegisvolt"
}

variable "expected_environment" {
  description = "Ambiente al que pertenece el tfvars; debe coincidir con el workspace activo."
  type        = string
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "aws_endpoint" {
  description = "Endpoint de Floci. null = AWS real."
  type        = string
  default     = "http://localhost:4566"
}

# --- Red ---------------------------------------------------------------------
variable "vpc_cidr" {
  type = string
}

variable "azs" {
  type    = list(string)
  default = ["us-east-1a", "us-east-1b"]
}

variable "interface_endpoint_services" {
  type    = list(string)
  default = ["execute-api", "logs", "monitoring", "sts", "ecr.api", "ecr.dkr", "eks"]
}

# --- DynamoDB / Feature flags --------------------------------------------------
variable "dynamodb_pitr" {
  type    = bool
  default = false
}

variable "dynamodb_deletion_protection" {
  type    = bool
  default = false
}

variable "feature_flags" {
  type = map(object({
    enabled     = bool
    description = string
  }))
}

# --- Observabilidad -----------------------------------------------------------
variable "log_retention_days" {
  type = number
}

variable "canary_error_threshold" {
  type    = number
  default = 1
}

# --- EKS ----------------------------------------------------------------------
variable "kubernetes_version" {
  type    = string
  default = "1.33"
}

variable "eks_public_access_cidrs" {
  type    = list(string)
  default = ["0.0.0.0/0"]
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

# --- API Gateway ----------------------------------------------------------------
variable "graphql_node_port" {
  type    = number
  default = 30080
}

variable "nlb_listener_port" {
  type = number
}

variable "cors_allow_origins" {
  type = list(string)
}

variable "api_throttling_burst_limit" {
  type = number
}

variable "api_throttling_rate_limit" {
  type = number
}

variable "enable_private_api" {
  type    = bool
  default = true
}

variable "frontend_listener_port" {
  type = number
}
