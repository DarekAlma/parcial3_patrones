# =============================================================================
# Frontend web por el MISMO API Gateway del ambiente
#
#   GET /            ┐
#   GET /{proxy+}    ┘-> VPC Link -> NLB (listener frontend) -> NodePort 30081 -> nginx
#   ANY /graphql       -> VPC Link -> NLB (listener graphql)  -> NodePort 30080 -> gateway
#
# API Gateway elige la ruta mas especifica: /graphql, /health y /flags van al
# gateway; todo lo demas es la UI. Mismo origen para la UI y la API (sin CORS).
# =============================================================================

resource "aws_vpc_security_group_egress_rule" "vpc_link_to_nlb_frontend" {
  security_group_id            = aws_security_group.vpc_link.id
  description                  = "Hacia el listener frontend del NLB interno"
  referenced_security_group_id = aws_security_group.nlb.id
  ip_protocol                  = "tcp"
  from_port                    = var.frontend_listener_port
  to_port                      = var.frontend_listener_port

  lifecycle {
    ignore_changes = [referenced_security_group_id]
  }
}

resource "aws_vpc_security_group_ingress_rule" "nlb_frontend_from_vpc_link" {
  security_group_id            = aws_security_group.nlb.id
  description                  = "Frontend desde el VPC Link"
  referenced_security_group_id = aws_security_group.vpc_link.id
  ip_protocol                  = "tcp"
  from_port                    = var.frontend_listener_port
  to_port                      = var.frontend_listener_port

  lifecycle {
    ignore_changes = [referenced_security_group_id]
  }
}

resource "aws_vpc_security_group_egress_rule" "nlb_to_nodes_frontend" {
  security_group_id            = aws_security_group.nlb.id
  description                  = "Hacia el NodePort del frontend"
  referenced_security_group_id = var.node_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = var.frontend_node_port
  to_port                      = var.frontend_node_port

  lifecycle {
    ignore_changes = [referenced_security_group_id]
  }
}

resource "aws_lb_target_group" "frontend" {
  name        = "${var.name}-tg-frontend"
  port        = var.frontend_node_port
  protocol    = "TCP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  tags        = var.tags

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

resource "aws_lb_listener" "frontend" {
  load_balancer_arn = aws_lb.internal.arn
  port              = var.frontend_listener_port
  protocol          = "TCP"
  tags              = var.tags

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.frontend.arn
  }
}

resource "aws_apigatewayv2_integration" "frontend" {
  api_id                 = aws_apigatewayv2_api.public.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "GET"
  connection_type        = "VPC_LINK"
  connection_id          = aws_apigatewayv2_vpc_link.this.id
  integration_uri        = aws_lb_listener.frontend.arn
  payload_format_version = "1.0"
  timeout_milliseconds   = 10000
}

resource "aws_apigatewayv2_route" "frontend" {
  for_each  = toset(["GET /", "GET /{proxy+}"])
  api_id    = aws_apigatewayv2_api.public.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.frontend.id}"
}
