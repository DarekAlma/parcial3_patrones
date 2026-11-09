output "vpc_id" {
  value = aws_vpc.this.id
}

output "vpc_cidr" {
  value = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "private_route_table_id" {
  value = aws_route_table.private.id
}

output "gateway_endpoint_ids" {
  value = {
    s3       = aws_vpc_endpoint.s3.id
    dynamodb = aws_vpc_endpoint.dynamodb.id
  }
}

# Map con claves estaticas (s3, dynamodb): utilizable en for_each.
output "gateway_endpoint_prefix_list_ids" {
  value = { for svc, pl in data.aws_prefix_list.gateway : svc => pl.id }
}

output "interface_endpoint_ids" {
  value = { for svc, ep in aws_vpc_endpoint.interface : svc => ep.id }
}

output "execute_api_vpce_id" {
  value = try(aws_vpc_endpoint.interface["execute-api"].id, null)
}
