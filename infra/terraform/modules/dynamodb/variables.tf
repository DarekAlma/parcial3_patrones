variable "name" {
  description = "Nombre de la tabla: <project>-<servicio>-<ambiente>."
  type        = string
}

variable "service" {
  description = "Microservicio duenio de la tabla."
  type        = string
}

variable "hash_key" {
  type    = string
  default = "pk"
}

variable "range_key" {
  type    = string
  default = "sk"
}

variable "attributes" {
  description = "Atributos indexados (clave => tipo S|N|B)."
  type        = map(string)
  default     = { pk = "S", sk = "S" }
}

variable "global_secondary_indexes" {
  type = list(object({
    name      = string
    hash_key  = string
    range_key = optional(string)
  }))
  default = []
}

variable "ttl_attribute" {
  type    = string
  default = null
}

variable "point_in_time_recovery" {
  type    = bool
  default = false
}

variable "deletion_protection" {
  type    = bool
  default = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
