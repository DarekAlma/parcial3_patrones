variable "project" {
  type = string
}

variable "environment" {
  type = string
}

variable "services" {
  description = "Servicios con log group propio."
  type        = list(string)
}

variable "saga_orchestrator_service" {
  description = "Servicio que orquesta la SAGA (emite saga_failed / saga_compensated)."
  type        = string
}

variable "log_retention_days" {
  type = number
}

variable "canary_error_threshold" {
  description = "Errores por minuto de la version canary que disparan la alarma."
  type        = number
  default     = 1
}

variable "tags" {
  type    = map(string)
  default = {}
}
