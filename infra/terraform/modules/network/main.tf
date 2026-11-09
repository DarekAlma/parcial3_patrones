# =============================================================================
# MODULO NETWORK - VPC dedicada por ambiente
#
#  Internet
#     |
#  [IGW] -- subredes PUBLICAS (rt-public: 0.0.0.0/0 -> IGW)
#
#  subredes PRIVADAS (rt-private: SIN ruta 0.0.0.0/0, sin NAT)
#     |-- EKS nodes, NLB interno, VPC Link de API Gateway
#     |-- Gateway VPCE  : S3, DynamoDB   (rutas por prefix-list en rt-private)
#     |-- Interface VPCE: execute-api, logs, monitoring, sts, ecr.api, ecr.dkr, eks
#
# Como las subredes privadas no tienen ruta a Internet, el UNICO camino de los
# pods hacia S3/DynamoDB/CloudWatch/API Gateway son los VPC Endpoints: el
# trafico interno nunca sale a la Internet publica.
# =============================================================================

locals {
  az_count = length(var.azs)
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_support   = true
  enable_dns_hostnames = true # requerido por private_dns_enabled en interface VPCE
  tags                 = merge(var.tags, { Name = "${var.name_prefix}-vpc" })
}

# ---------------------------------------------------------------------------
# Subredes: /20 por subred. Publicas = indices 0..n-1, privadas = 8..8+n-1
# ---------------------------------------------------------------------------
resource "aws_subnet" "public" {
  count                   = local.az_count
  vpc_id                  = aws_vpc.this.id
  availability_zone       = var.azs[count.index]
  cidr_block              = cidrsubnet(var.cidr, 4, count.index)
  map_public_ip_on_launch = true
  tags = merge(var.tags, {
    Name                     = "${var.name_prefix}-public-${var.azs[count.index]}"
    Tier                     = "public"
    "kubernetes.io/role/elb" = "1"
  })
}

resource "aws_subnet" "private" {
  count             = local.az_count
  vpc_id            = aws_vpc.this.id
  availability_zone = var.azs[count.index]
  cidr_block        = cidrsubnet(var.cidr, 4, count.index + 8)
  tags = merge(var.tags, {
    Name                              = "${var.name_prefix}-private-${var.azs[count.index]}"
    Tier                              = "private"
    "kubernetes.io/role/internal-elb" = "1"
  })
}

# ---------------------------------------------------------------------------
# Enrutamiento
# ---------------------------------------------------------------------------
resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name_prefix}-igw" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name_prefix}-rt-public" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = local.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Tabla privada: solo la ruta "local" de la VPC + rutas de los Gateway VPCE.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name_prefix}-rt-private" })
}

resource "aws_route_table_association" "private" {
  count          = local.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ---------------------------------------------------------------------------
# Gateway VPC Endpoints (S3 y DynamoDB)
# AWS inyecta en rt-private una ruta: <prefix-list del servicio> -> vpce-xxxx
# Las policies limitan el endpoint a los recursos de ESTE ambiente.
# ---------------------------------------------------------------------------
resource "aws_vpc_endpoint" "dynamodb" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
  tags              = merge(var.tags, { Name = "${var.name_prefix}-vpce-dynamodb" })

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "OnlyThisEnvironmentTables"
      Effect    = "Allow"
      Principal = "*"
      Action    = ["dynamodb:*"]
      Resource = [
        "arn:aws:dynamodb:${var.region}:*:table/${var.project}-*-${var.environment}",
        "arn:aws:dynamodb:${var.region}:*:table/${var.project}-*-${var.environment}/index/*",
      ]
    }]
  })
}

# Prefix lists administradas por AWS (rangos IP publicos de S3 y DynamoDB).
# Son el destino de las rutas que inyectan los Gateway VPCE y se usan en las
# reglas de salida de los security groups.
data "aws_prefix_list" "gateway" {
  for_each = toset(["s3", "dynamodb"])
  name     = "com.amazonaws.${var.region}.${each.value}"
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
  tags              = merge(var.tags, { Name = "${var.name_prefix}-vpce-s3" })

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "OnlyProjectBuckets"
      Effect    = "Allow"
      Principal = "*"
      Action    = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
      Resource = [
        "arn:aws:s3:::${var.project}-*",
        "arn:aws:s3:::${var.project}-*/*",
        # Capas de imagenes de ECR viven en S3 administrado por AWS.
        "arn:aws:s3:::prod-${var.region}-starport-layer-bucket/*",
      ]
    }]
  })
}

# ---------------------------------------------------------------------------
# Interface VPC Endpoints (ENIs en subredes privadas + DNS privado)
# ---------------------------------------------------------------------------
resource "aws_security_group" "vpce" {
  name        = "${var.name_prefix}-sg-vpce"
  description = "HTTPS desde la VPC hacia los Interface VPC Endpoints"
  vpc_id      = aws_vpc.this.id
  tags        = merge(var.tags, { Name = "${var.name_prefix}-sg-vpce" })
}

resource "aws_vpc_security_group_ingress_rule" "vpce_https" {
  security_group_id = aws_security_group.vpce.id
  description       = "HTTPS desde la VPC"
  cidr_ipv4         = var.cidr
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_endpoint" "interface" {
  for_each = toset(var.interface_endpoint_services)

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${var.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.vpce.id]
  private_dns_enabled = true
  tags                = merge(var.tags, { Name = "${var.name_prefix}-vpce-${replace(each.value, ".", "-")}" })
}
