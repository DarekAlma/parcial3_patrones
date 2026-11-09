"""Flow padre: salud de ambientes + auditoria SAGA en una sola corrida (para la demo)."""
from prefect import flow

from .aws import ENVIRONMENTS
from .health import environment_health
from .saga_audit import saga_consistency_audit


@flow(name="aegisvolt-observability")
def observability_pipeline(environments: list[str] = ENVIRONMENTS, auto_recover: bool = True) -> dict:
    health = environment_health(environments, return_state=True)
    audit = saga_consistency_audit(environments, auto_recover=auto_recover, return_state=True)
    return {"health": health.type.value, "audit": audit.type.value}
