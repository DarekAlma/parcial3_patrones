variable "project" {
  type = string
}

variable "environment" {
  type = string
}

variable "services" {
  type = list(string)
}

variable "keep_images" {
  type    = number
  default = 20
}

variable "tags" {
  type    = map(string)
  default = {}
}
