variable "project" {
  type = string
}

variable "environment" {
  type = string
}

variable "flags" {
  description = "Valor inicial de cada flag en este ambiente."
  type = map(object({
    enabled     = bool
    description = string
  }))
}

variable "deletion_protection" {
  type    = bool
  default = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
