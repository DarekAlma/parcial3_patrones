# =============================================================================
# BOOTSTRAP - Backend remoto de Terraform
#
# Crea el bucket S3 donde viven TODOS los terraform.tfstate del proyecto:
#   - Versioning Enabled: cada apply genera una version nueva del tfstate y las
#     anteriores quedan como backups historicos (restaurables).
#   - Cifrado SSE, bloqueo de acceso publico y retencion de versiones antiguas.
#
# Problema del huevo y la gallina: el backend S3 necesita que el bucket exista
# antes de "terraform init". scripts/infra/bootstrap.ps1 lo resuelve:
#   1. init/apply con backend local temporal (backend_override.tf)
#   2. borra el override y migra ESTE estado al propio bucket
#      (terraform init -migrate-state) => key bootstrap/terraform.tfstate
# =============================================================================

locals {
  state_bucket = "${var.project}-tfstate"
  tags = {
    Project   = var.project
    ManagedBy = "terraform"
    Stack     = "bootstrap"
  }
}

resource "aws_s3_bucket" "tfstate" {
  bucket = local.state_bucket
  tags   = local.tags

  # El bucket guarda el estado de todos los ambientes: nunca se destruye por error.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Conserva las versiones antiguas del tfstate durante N dias (auditoria) y
# limpia cargas multipart incompletas.
resource "aws_s3_bucket_lifecycle_configuration" "tfstate" {
  bucket     = aws_s3_bucket.tfstate.id
  depends_on = [aws_s3_bucket_versioning.tfstate]

  rule {
    id     = "retain-noncurrent-state-versions"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}
