provider "aws" {
  region                      = var.region
  s3_use_path_style           = var.aws_endpoint != null
  skip_credentials_validation = var.aws_endpoint != null
  skip_requesting_account_id  = var.aws_endpoint != null
  skip_metadata_api_check     = var.aws_endpoint != null

  # Floci expone todos los servicios en un solo puerto. Con aws_endpoint = null
  # se usan los endpoints reales de AWS sin tocar el resto del codigo.
  dynamic "endpoints" {
    for_each = var.aws_endpoint == null ? [] : [var.aws_endpoint]
    content {
      apigateway   = endpoints.value
      apigatewayv2 = endpoints.value
      cloudwatch   = endpoints.value
      dynamodb     = endpoints.value
      ec2          = endpoints.value
      eks          = endpoints.value
      elbv2        = endpoints.value
      iam          = endpoints.value
      logs         = endpoints.value
      s3           = endpoints.value
      sts          = endpoints.value
    }
  }

  # Etiquetas en TODOS los recursos: permiten auditar a que ambiente pertenece cada uno.
  default_tags {
    tags = {
      Project     = var.project
      Environment = local.environment
      Workspace   = terraform.workspace
      ManagedBy   = "terraform"
    }
  }
}
