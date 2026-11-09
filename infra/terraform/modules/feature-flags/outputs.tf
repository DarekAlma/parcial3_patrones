output "table_name" {
  value = aws_dynamodb_table.flags.name
}

output "table_arn" {
  value = aws_dynamodb_table.flags.arn
}

output "initial_flags" {
  value = { for k, v in var.flags : k => v.enabled }
}
