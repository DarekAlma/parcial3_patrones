# =============================================================================
# MODULO OBSERVABILITY - CloudWatch por ambiente
#
# Log groups:  /aegisvolt/<env>/<servicio>
# Cada servicio escribe logs JSON estructurados con, al menos:
#   { "level", "service", "environment", "track" (stable|canary),
#     "correlation_id" (id de la SAGA), "event", "message" }
#
# Metric filters -> namespace AegisVolt/<env>, dimensiones Service y Track:
#   RequestCount      cada request HTTP atendida   (event = "http_request")
#   ErrorCount        cada log level = ERROR
#   SagaCompensated   SAGA revertida con compensaciones
#   SagaFailed        SAGA que no pudo completarse ni compensarse
#
# El canary deployment compara ErrorCount/RequestCount de Track=canary contra
# el umbral antes de promover al 100% (ver scripts/ci/canary-deploy.ps1).
# =============================================================================

locals {
  namespace = "AegisVolt/${var.environment}"

  dimensions = {
    Service = "$.service"
    Track   = "$.track"
  }

  metric_filters = {
    RequestCount    = "{ $.event = \"http_request\" }"
    ErrorCount      = "{ $.level = \"ERROR\" }"
    SagaCompensated = "{ $.event = \"saga_compensated\" }"
    SagaFailed      = "{ $.event = \"saga_failed\" }"
  }

  # Producto cartesiano servicio x metrica
  filters = merge([
    for svc in var.services : {
      for metric, pattern in local.metric_filters :
      "${svc}.${metric}" => { service = svc, metric = metric, pattern = pattern }
    }
  ]...)
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = toset(var.services)
  name              = "/${var.project}/${var.environment}/${each.value}"
  retention_in_days = var.log_retention_days
  tags              = merge(var.tags, { Service = each.value })
}

# Access logs de API Gateway (formato JSON con requestId).
resource "aws_cloudwatch_log_group" "api_gateway" {
  name              = "/${var.project}/${var.environment}/api-gateway"
  retention_in_days = var.log_retention_days
  tags              = merge(var.tags, { Service = "api-gateway" })
}

resource "aws_cloudwatch_log_metric_filter" "this" {
  for_each       = local.filters
  name           = "${var.project}-${var.environment}-${each.value.service}-${each.value.metric}"
  log_group_name = aws_cloudwatch_log_group.service[each.value.service].name
  pattern        = each.value.pattern

  metric_transformation {
    name       = each.value.metric
    namespace  = local.namespace
    value      = "1"
    unit       = "Count"
    dimensions = local.dimensions
  }
}

# Alarma usada por el canary: errores de la version canary en 1 minuto.
resource "aws_cloudwatch_metric_alarm" "canary_errors" {
  for_each            = toset(var.services)
  alarm_name          = "${var.project}-${var.environment}-${each.value}-canary-errors"
  alarm_description   = "Errores de la version canary de ${each.value} en ${var.environment}"
  namespace           = local.namespace
  metric_name         = "ErrorCount"
  dimensions          = { Service = each.value, Track = "canary" }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = var.canary_error_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  tags                = var.tags
}

# Alarma de negocio: SAGAs que quedaron sin completar ni compensar.
resource "aws_cloudwatch_metric_alarm" "saga_failed" {
  alarm_name          = "${var.project}-${var.environment}-saga-failed"
  alarm_description   = "SAGAs fallidas sin compensacion completa en ${var.environment}"
  namespace           = local.namespace
  metric_name         = "SagaFailed"
  dimensions          = { Service = var.saga_orchestrator_service, Track = "stable" }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  tags                = var.tags
}
