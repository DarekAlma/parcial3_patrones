# =============================================================================
# MODULO API GATEWAY - punto de entrada hacia la capa GraphQL en EKS
#
# Ruta del trafico PUBLICO (cliente / frontend):
#
#   Cliente --HTTPS--> API Gateway HTTP API (aegisvolt-<env>)
#            --> VPC Link (ENIs en subredes privadas, sg-vpclink)
#            --> NLB interno (subredes privadas, sg-nlb, listener TCP)
#            --> Target group (IP del nodo EKS : NodePort 30080)
#            --> kube-proxy --> Service graphql-gateway --> Pod (stable|canary)
#
# Ruta del trafico INTERNO (workloads dentro de la VPC, p. ej. flujos Prefect):
#
#   Pod / worker --> DNS privado de execute-api --> Interface VPCE execute-api
#            --> API Gateway REST API PRIVATE (aegisvolt-internal-<env>)
#            --> VPC Link REST --> NLB interno --> ... --> Pod
#
#   La resource policy de la API privada solo acepta llamadas que entran por
#   el VPCE del ambiente (aws:SourceVpce). Desde Internet no es alcanzable.
#
# Los targets del NLB los registra el pipeline de despliegue
# (scripts/k8s/register-nlb-targets.ps1), igual que lo haria el AWS Load
# Balancer Controller con un TargetGroupBinding: Terraform es duenio del NLB,
# del target group y del listener; Kubernetes es duenio de los targets.
# =============================================================================

# ---------------------------------------------------------------------------
# Security groups
# ---------------------------------------------------------------------------
resource "aws_security_group" "vpc_link" {
  name        = "${var.name}-sg-vpclink"
  description = "ENIs del VPC Link de API Gateway"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-sg-vpclink" })
}

resource "aws_vpc_security_group_egress_rule" "vpc_link_to_nlb" {
  security_group_id            = aws_security_group.vpc_link.id
  description                  = "Hacia el listener del NLB interno"
  referenced_security_group_id = aws_security_group.nlb.id
  ip_protocol                  = "tcp"
  from_port                    = var.nlb_listener_port
  to_port                      = var.nlb_listener_port
  # Floci devuelve el SG referenciado como "<account>/sg-xxxx" (formato de
  # referencia cross-account) y el provider lo ve como drift perpetuo.
  # En AWS real esta linea es innecesaria.
  lifecycle {
    ignore_changes = [referenced_security_group_id]
  }
}

resource "aws_security_group" "nlb" {
  name        = "${var.name}-sg-nlb"
  description = "NLB interno: solo acepta trafico del VPC Link y de la VPC"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-sg-nlb" })
}

resource "aws_vpc_security_group_ingress_rule" "nlb_from_vpc_link" {
  security_group_id            = aws_security_group.nlb.id
  description                  = "Desde el VPC Link"
  referenced_security_group_id = aws_security_group.vpc_link.id
  ip_protocol                  = "tcp"
  from_port                    = var.nlb_listener_port
  to_port                      = var.nlb_listener_port
  # Floci devuelve el SG referenciado como "<account>/sg-xxxx" (formato de
  # referencia cross-account) y el provider lo ve como drift perpetuo.
  # En AWS real esta linea es innecesaria.
  lifecycle {
    ignore_changes = [referenced_security_group_id]
  }
}

resource "aws_vpc_security_group_ingress_rule" "nlb_from_vpc" {
  security_group_id = aws_security_group.nlb.id
  description       = "Desde la VPC (API privada via VPCE)"
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = var.nlb_listener_port
  to_port           = var.nlb_listener_port
}

resource "aws_vpc_security_group_egress_rule" "nlb_to_nodes" {
  security_group_id            = aws_security_group.nlb.id
  description                  = "Hacia el NodePort de los nodos EKS"
  referenced_security_group_id = var.node_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = var.node_port
  to_port                      = var.node_port
  # Floci devuelve el SG referenciado como "<account>/sg-xxxx" (formato de
  # referencia cross-account) y el provider lo ve como drift perpetuo.
  # En AWS real esta linea es innecesaria.
  lifecycle {
    ignore_changes = [referenced_security_group_id]
  }
}

# ---------------------------------------------------------------------------
# NLB interno
# ---------------------------------------------------------------------------
resource "aws_lb" "internal" {
  name               = "${var.name}-nlb"
  load_balancer_type = "network"
  internal           = true
  subnets            = var.private_subnet_ids
  security_groups    = [aws_security_group.nlb.id]
  tags               = var.tags
}

resource "aws_lb_target_group" "graphql" {
  name        = "${var.name}-tg-graphql"
  port        = var.node_port
  protocol    = "TCP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  tags        = var.tags

  # Health check HTTP (no solo TCP): un target solo recibe trafico si la app
  # responde /health, no basta con que el puerto este abierto.
  health_check {
    protocol            = "HTTP"
    port                = "traffic-port"
    path                = "/health"
    matcher             = "200-399"
    interval            = 10
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}

resource "aws_lb_listener" "graphql" {
  load_balancer_arn = aws_lb.internal.arn
  port              = var.nlb_listener_port
  protocol          = "TCP"
  tags              = var.tags

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.graphql.arn
  }
}

# ---------------------------------------------------------------------------
# API publica: HTTP API + VPC Link
# ---------------------------------------------------------------------------
resource "aws_apigatewayv2_vpc_link" "this" {
  name               = "${var.name}-vpclink"
  subnet_ids         = var.private_subnet_ids
  security_group_ids = [aws_security_group.vpc_link.id]
  tags               = var.tags
}

resource "aws_apigatewayv2_api" "public" {
  name          = var.name
  description   = "AegisVolt GraphQL API (${var.environment})"
  protocol_type = "HTTP"
  tags          = var.tags

  cors_configuration {
    allow_origins = var.cors_allow_origins
    allow_methods = ["GET", "POST", "OPTIONS"]
    allow_headers = ["content-type", "authorization", "x-correlation-id"]
    max_age       = 300
  }
}

resource "aws_apigatewayv2_integration" "graphql" {
  api_id                 = aws_apigatewayv2_api.public.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  connection_type        = "VPC_LINK"
  connection_id          = aws_apigatewayv2_vpc_link.this.id
  integration_uri        = aws_lb_listener.graphql.arn
  payload_format_version = "1.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_route" "this" {
  for_each  = toset(var.routes)
  api_id    = aws_apigatewayv2_api.public.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.graphql.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.public.id
  name        = "$default"
  auto_deploy = true
  tags        = var.tags

  default_route_settings {
    throttling_burst_limit = var.throttling_burst_limit
    throttling_rate_limit  = var.throttling_rate_limit
  }

  access_log_settings {
    destination_arn = var.access_log_group_arn
    format = jsonencode({
      requestId      = "$context.requestId"
      correlation_id = "$context.requestId"
      environment    = var.environment
      service        = "api-gateway"
      ip             = "$context.identity.sourceIp"
      method         = "$context.httpMethod"
      path           = "$context.path"
      status         = "$context.status"
      latency        = "$context.responseLatency"
      integration    = "$context.integrationStatus"
    })
  }
}

# ---------------------------------------------------------------------------
# API interna PRIVADA: REST API alcanzable solo via Interface VPCE execute-api
# ---------------------------------------------------------------------------
resource "aws_api_gateway_vpc_link" "internal" {
  count       = var.enable_private_api ? 1 : 0
  name        = "${var.name}-internal-vpclink"
  target_arns = [aws_lb.internal.arn]
  tags        = var.tags
}

resource "aws_api_gateway_rest_api" "internal" {
  count       = var.enable_private_api ? 1 : 0
  name        = "${var.name}-internal"
  description = "API interna privada de AegisVolt (${var.environment}) - solo via VPCE"
  tags        = var.tags

  endpoint_configuration {
    types            = ["PRIVATE"]
    vpc_endpoint_ids = [var.execute_api_vpce_id]
  }
}

resource "aws_api_gateway_rest_api_policy" "internal" {
  count       = var.enable_private_api ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.internal[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowOnlyFromEnvironmentVpce"
        Effect    = "Allow"
        Principal = "*"
        Action    = "execute-api:Invoke"
        Resource  = "${aws_api_gateway_rest_api.internal[0].execution_arn}/*"
        Condition = { StringEquals = { "aws:SourceVpce" = var.execute_api_vpce_id } }
      },
      {
        Sid       = "DenyOutsideVpce"
        Effect    = "Deny"
        Principal = "*"
        Action    = "execute-api:Invoke"
        Resource  = "${aws_api_gateway_rest_api.internal[0].execution_arn}/*"
        Condition = { StringNotEquals = { "aws:SourceVpce" = var.execute_api_vpce_id } }
      },
    ]
  })
}

resource "aws_api_gateway_resource" "internal_proxy" {
  count       = var.enable_private_api ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.internal[0].id
  parent_id   = aws_api_gateway_rest_api.internal[0].root_resource_id
  path_part   = "{proxy+}"
}

resource "aws_api_gateway_method" "internal_proxy" {
  count              = var.enable_private_api ? 1 : 0
  rest_api_id        = aws_api_gateway_rest_api.internal[0].id
  resource_id        = aws_api_gateway_resource.internal_proxy[0].id
  http_method        = "ANY"
  authorization      = "NONE"
  request_parameters = { "method.request.path.proxy" = true }
}

resource "aws_api_gateway_integration" "internal_proxy" {
  count                   = var.enable_private_api ? 1 : 0
  rest_api_id             = aws_api_gateway_rest_api.internal[0].id
  resource_id             = aws_api_gateway_resource.internal_proxy[0].id
  http_method             = aws_api_gateway_method.internal_proxy[0].http_method
  type                    = "HTTP_PROXY"
  integration_http_method = "ANY"
  connection_type         = "VPC_LINK"
  connection_id           = aws_api_gateway_vpc_link.internal[0].id
  uri                     = "http://${aws_lb.internal.dns_name}:${var.nlb_listener_port}/{proxy}"
  request_parameters      = { "integration.request.path.proxy" = "method.request.path.proxy" }
}

resource "aws_api_gateway_deployment" "internal" {
  count       = var.enable_private_api ? 1 : 0
  rest_api_id = aws_api_gateway_rest_api.internal[0].id

  triggers = {
    redeploy = sha1(jsonencode([
      aws_api_gateway_resource.internal_proxy[0].id,
      aws_api_gateway_method.internal_proxy[0].id,
      aws_api_gateway_integration.internal_proxy[0].id,
      aws_api_gateway_rest_api_policy.internal[0].policy,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "internal" {
  count         = var.enable_private_api ? 1 : 0
  rest_api_id   = aws_api_gateway_rest_api.internal[0].id
  deployment_id = aws_api_gateway_deployment.internal[0].id
  stage_name    = var.environment
  tags          = var.tags
}
