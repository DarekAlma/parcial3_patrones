# Ambiente TEST - usar SOLO con: terraform workspace select test
expected_environment = "test"

vpc_cidr = "10.20.0.0/16"

node_desired_size = 1
node_min_size     = 1
node_max_size     = 2

nlb_listener_port          = 18081
cors_allow_origins         = ["*"]
api_throttling_burst_limit = 100
api_throttling_rate_limit  = 50

log_retention_days     = 14
canary_error_threshold = 1

dynamodb_pitr                = false
dynamodb_deletion_protection = false

feature_flags = {
  ENABLE_DYNAMIC_SURGE_PRICING = {
    enabled     = true
    description = "Tarifas dinamicas en horas pico."
  }
  ENABLE_FAST_CHARGE_BOOST = {
    enabled     = true
    description = "Reserva prioritaria de ultra-carga."
  }
  SIMULATE_CHARGER_HARDWARE_FAULT = {
    enabled     = false
    description = "Inyeccion de fallos: el cargador reporta error fisico y se dispara el rollback de la SAGA."
  }
}
