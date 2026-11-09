# Ambiente PROD - usar SOLO con: terraform workspace select prod
expected_environment = "prod"

vpc_cidr = "10.30.0.0/16"

node_desired_size = 2
node_min_size     = 2
node_max_size     = 4

nlb_listener_port          = 18082
cors_allow_origins         = ["*"]
api_throttling_burst_limit = 500
api_throttling_rate_limit  = 200

log_retention_days     = 30
canary_error_threshold = 1

# Prod protege sus datos: backups continuos y bloqueo de borrado.
dynamodb_pitr                = true
dynamodb_deletion_protection = true

feature_flags = {
  ENABLE_DYNAMIC_SURGE_PRICING = {
    enabled     = false
    description = "Tarifas dinamicas en horas pico."
  }
  ENABLE_FAST_CHARGE_BOOST = {
    enabled     = false
    description = "Reserva prioritaria de ultra-carga."
  }
  SIMULATE_CHARGER_HARDWARE_FAULT = {
    enabled     = false
    description = "Inyeccion de fallos: el cargador reporta error fisico y se dispara el rollback de la SAGA."
  }
}
