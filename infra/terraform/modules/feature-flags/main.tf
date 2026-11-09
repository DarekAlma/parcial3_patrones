# =============================================================================
# MODULO FEATURE FLAGS - sistema propio sobre DynamoDB, uno por ambiente
#
# Tabla aegisvolt-feature-flags-<env>: cada ambiente tiene su PROPIO estado.
# Terraform siembra el valor inicial de cada flag; despues el estado se cambia
# en caliente (CLI / UI / API) SIN redesplegar codigo. Por eso los items
# ignoran cambios posteriores: un "terraform apply" no pisa un toggle hecho
# en runtime.
# =============================================================================

resource "aws_dynamodb_table" "flags" {
  name                        = "${var.project}-feature-flags-${var.environment}"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "flag"
  deletion_protection_enabled = var.deletion_protection
  tags                        = merge(var.tags, { Name = "${var.project}-feature-flags-${var.environment}", Service = "feature-flags" })

  attribute {
    name = "flag"
    type = "S"
  }

  server_side_encryption {
    enabled = true
  }
}

resource "aws_dynamodb_table_item" "flag" {
  for_each   = var.flags
  table_name = aws_dynamodb_table.flags.name
  hash_key   = aws_dynamodb_table.flags.hash_key

  item = jsonencode({
    flag        = { S = each.key }
    enabled     = { BOOL = each.value.enabled }
    description = { S = each.value.description }
    environment = { S = var.environment }
    updatedBy   = { S = "terraform" }
  })

  lifecycle {
    ignore_changes = [item]
  }
}
