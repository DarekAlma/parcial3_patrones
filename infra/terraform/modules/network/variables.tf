variable "project" {
  type = string
}

variable "environment" {
  type = string
}

variable "name_prefix" {
  description = "Prefijo de nombres, p. ej. aegisvolt-dev."
  type        = string
}

variable "region" {
  type = string
}

variable "cidr" {
  description = "CIDR de la VPC. Distinto por ambiente para permitir peering futuro sin solapes."
  type        = string
}

variable "azs" {
  description = "Zonas de disponibilidad (una subred publica y una privada por AZ)."
  type        = list(string)
}

variable "interface_endpoint_services" {
  description = "Servicios con Interface VPCE (sufijo de com.amazonaws.<region>.<svc>)."
  type        = list(string)
}

variable "tags" {
  type    = map(string)
  default = {}
}
