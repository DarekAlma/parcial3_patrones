output "log_groups" {
  value = { for svc, lg in aws_cloudwatch_log_group.service : svc => lg.name }
}

output "api_gateway_log_group_arn" {
  value = aws_cloudwatch_log_group.api_gateway.arn
}

output "metrics_namespace" {
  value = local.namespace
}

output "canary_alarm_names" {
  value = { for svc, a in aws_cloudwatch_metric_alarm.canary_errors : svc => a.alarm_name }
}
