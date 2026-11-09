# =============================================================================
# MODULO ECR - un repositorio de imagenes por microservicio y ambiente
#   aegisvolt-<env>/<servicio>
#
# - IMMUTABLE: un tag nunca se sobrescribe; el tag es el hash del contenido del
#   servicio, asi que la misma version de codigo produce el mismo tag en dev,
#   test y prod (trazabilidad de lo que se promueve).
# - scan_on_push y lifecycle: se conservan las ultimas N imagenes (rollback).
# =============================================================================

resource "aws_ecr_repository" "service" {
  for_each             = toset(var.services)
  name                 = "${var.project}-${var.environment}/${each.value}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.environment != "prod"
  tags                 = merge(var.tags, { Service = each.value })

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "service" {
  for_each   = aws_ecr_repository.service
  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Conservar las ultimas ${var.keep_images} imagenes"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = var.keep_images
      }
      action = { type = "expire" }
    }]
  })
}
