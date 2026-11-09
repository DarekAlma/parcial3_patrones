# =============================================================================
# MODULO DYNAMODB - una tabla por servicio (Database-per-Service)
#
# Esquema generico pk/sk (single-table design por servicio) + GSI opcionales.
# Ningun servicio lee la tabla de otro: la consistencia entre servicios se
# logra con la SAGA y sus transacciones compensatorias, no con joins ni ACID.
# =============================================================================

resource "aws_dynamodb_table" "this" {
  name                        = var.name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = var.hash_key
  range_key                   = var.range_key
  deletion_protection_enabled = var.deletion_protection
  tags                        = merge(var.tags, { Name = var.name, Service = var.service })

  dynamic "attribute" {
    for_each = var.attributes
    content {
      name = attribute.key
      type = attribute.value
    }
  }

  dynamic "global_secondary_index" {
    for_each = var.global_secondary_indexes
    content {
      name            = global_secondary_index.value.name
      projection_type = "ALL"

      key_schema {
        attribute_name = global_secondary_index.value.hash_key
        key_type       = "HASH"
      }

      dynamic "key_schema" {
        for_each = global_secondary_index.value.range_key == null ? [] : [global_secondary_index.value.range_key]
        content {
          attribute_name = key_schema.value
          key_type       = "RANGE"
        }
      }
    }
  }

  # TTL: DynamoDB borra automaticamente items vencidos (p. ej. bloqueos
  # temporales de bahias que nunca se confirmaron).
  dynamic "ttl" {
    for_each = var.ttl_attribute == null ? [] : [var.ttl_attribute]
    content {
      attribute_name = ttl.value
      enabled        = true
    }
  }

  point_in_time_recovery {
    enabled = var.point_in_time_recovery
  }

  server_side_encryption {
    enabled = true
  }
}
