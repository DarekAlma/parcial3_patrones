"""
Publica los flows como deployments programados en el servidor Prefect y los
ejecuta en este mismo proceso (prefect serve). Dashboard: http://localhost:4200
"""
from prefect import serve

from .health import environment_health
from .pipeline import observability_pipeline
from .saga_audit import saga_consistency_audit

if __name__ == "__main__":
    serve(
        environment_health.to_deployment(name="every-2-minutes", interval=120, tags=["aegisvolt", "health"]),
        saga_consistency_audit.to_deployment(name="every-5-minutes", interval=300, tags=["aegisvolt", "saga"]),
        observability_pipeline.to_deployment(name="on-demand", tags=["aegisvolt"]),
    )
