variable "project" {
  description = "Prefijo de todos los recursos."
  type        = string
  default     = "aegisvolt"
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

variable "noncurrent_version_retention_days" {
  description = "Dias que se conservan las versiones antiguas del tfstate."
  type        = number
  default     = 365
}
