variable "name" {
  description = "Prefijo de nombres: <project>-<env>."
  type        = string
}

variable "environment" {
  type = string
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

variable "node_security_group_id" {
  type = string
}

variable "node_port" {
  description = "NodePort del Service graphql-gateway en Kubernetes."
  type        = number
  default     = 30080
}

variable "nlb_listener_port" {
  description = "Puerto TCP del listener del NLB interno (unico por ambiente en Floci)."
  type        = number
}

variable "routes" {
  type    = list(string)
  default = ["ANY /graphql", "GET /health", "GET /flags"]
}

variable "cors_allow_origins" {
  type = list(string)
}

variable "throttling_burst_limit" {
  type = number
}

variable "throttling_rate_limit" {
  type = number
}

variable "access_log_group_arn" {
  type = string
}

variable "enable_private_api" {
  description = "Crea la REST API PRIVATE accesible solo por el VPCE execute-api."
  type        = bool
  default     = true
}

variable "execute_api_vpce_id" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
