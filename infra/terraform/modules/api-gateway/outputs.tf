output "public_api_id" {
  value = aws_apigatewayv2_api.public.id
}

output "public_api_endpoint" {
  value = aws_apigatewayv2_api.public.api_endpoint
}

output "nlb_arn" {
  value = aws_lb.internal.arn
}

output "nlb_dns_name" {
  value = aws_lb.internal.dns_name
}

output "nlb_listener_arn" {
  value = aws_lb_listener.graphql.arn
}

output "target_group_arn" {
  value = aws_lb_target_group.graphql.arn
}

output "vpc_link_id" {
  value = aws_apigatewayv2_vpc_link.this.id
}

output "private_api_id" {
  value = try(aws_api_gateway_rest_api.internal[0].id, null)
}

output "private_api_invoke_url" {
  value = try(aws_api_gateway_stage.internal[0].invoke_url, null)
}

output "frontend_target_group_arn" {
  value = aws_lb_target_group.frontend.arn
}
