"""
Flow saga-consistency-audit: audita la consistencia de las transacciones SAGA.

Por ambiente:
  1. Lee el log de SAGAs (aegisvolt-saga-<env>).
  2. Para cada SAGA terminal cruza su estado con las tablas de CADA servicio
     (reservations, billing, dispatch) y verifica los invariantes
     (audit_rules.check_consistency): p. ej. "COMPENSATED => hubo reembolso".
  3. Detecta SAGAs HUERFANAS (no terminales y sin avanzar > N segundos: el
     orquestador murio a mitad de camino) y, si auto_recover, las compensa
     llamando a la mutation recoverTransaction por la API interna PRIVADA
     (en AWS: solo alcanzable via el VPC Endpoint execute-api).
  4. Publica metricas (AegisVolt/Audit) y artifacts en el dashboard de Prefect.

El flow termina en Failed si quedan SAGAs inconsistentes o que requieren
intervencion: el dashboard las muestra en rojo.
"""
from __future__ import annotations

from typing import Any, Optional

import httpx
from boto3.dynamodb.types import TypeDeserializer
from prefect import flow, get_run_logger, task
from prefect.artifacts import create_markdown_artifact, create_table_artifact

from .audit_rules import AuditResult, SagaFacts, classify, summarize, utcnow
from .aws import ENVIRONMENTS, client, private_api_url, public_api_url, scan_all, table

_des = TypeDeserializer()


def _plain(item: dict) -> dict:
    return {k: _des.deserialize(v) for k, v in item.items()}


def _get(table_name: str, pk: str, sk: str) -> Optional[dict]:
    res = client("dynamodb").get_item(TableName=table_name, Key={"pk": {"S": pk}, "sk": {"S": sk}})
    return _plain(res["Item"]) if "Item" in res else None


@task(name="load-sagas", tags=["dynamodb"])
def load_sagas(env: str, limit: int) -> list[dict]:
    items = scan_all(table("saga", env), FilterExpression="sk = :m", ExpressionAttributeValues={":m": {"S": "META"}})
    sagas = sorted((_plain(i) for i in items), key=lambda s: s["createdAt"], reverse=True)
    return sagas[:limit]


def gather_facts(env: str, saga: dict) -> SagaFacts:
    saga_id = saga["sagaId"]
    fleet = saga.get("input", {}).get("fleetId")
    reservation = _get(table("reservations", env), f"RESERVATION#{saga_id}", "META")
    locked = False
    if reservation:
        connector = _get(table("reservations", env), f"STATION#{reservation['stationId']}", f"CONNECTOR#{reservation['connectorId']}")
        locked = bool(connector and connector.get("reservedBy") == saga_id and connector.get("status") in ("RESERVED", "CHARGING"))
    charge = _get(table("billing", env), f"WALLET#{fleet}", f"TXN#{saga_id}#CHARGE") if fleet else None
    refund = _get(table("billing", env), f"WALLET#{fleet}", f"TXN#{saga_id}#REFUND") if fleet else None
    session = _get(table("dispatch", env), f"SESSION#{saga_id}", "META")
    return SagaFacts(
        reservation_status=reservation.get("status") if reservation else None,
        connector_locked_by_saga=locked,
        charged=charge is not None,
        refunded=refund is not None,
        session_status=session.get("status") if session else None,
    )


@task(name="audit-sagas", tags=["saga"])
def audit_sagas(env: str, sagas: list[dict], orphan_after_seconds: int) -> list[AuditResult]:
    now = utcnow()
    results = []
    for s in sagas:
        facts = gather_facts(env, s) if s["status"] in ("COMPLETED", "COMPENSATED") else None
        results.append(classify(s, facts, now, orphan_after_seconds))
    return results


@task(name="recover-orphan", retries=2, retry_delay_seconds=5, tags=["saga", "remediation"])
def recover_orphan(env: str, saga_id: str) -> dict[str, Any]:
    """Compensa una SAGA huerfana via GraphQL. Prioriza la API interna privada."""
    mutation = {
        "query": "mutation($id: ID!) { recoverTransaction(sagaId: $id) { sagaId status compensations { step outcome } } }",
        "variables": {"id": saga_id},
    }
    for label, base in (("private", private_api_url(env)), ("public", public_api_url(env))):
        if not base:
            continue
        try:
            body = httpx.post(f"{base}/graphql", json=mutation, headers={"x-correlation-id": saga_id}, timeout=30).json()
            if body.get("data", {}).get("recoverTransaction"):
                return {"via": label, **body["data"]["recoverTransaction"]}
        except Exception:  # noqa: BLE001 - se intenta el siguiente camino
            continue
    raise RuntimeError(f"No se pudo recuperar la SAGA {saga_id}")


@task(name="publish-audit-metrics", tags=["cloudwatch"])
def publish_metrics(env: str, counts: dict[str, int]) -> None:
    dims = [{"Name": "Environment", "Value": env}]
    mapping = {
        "SagaTotal": counts["TOTAL"],
        "SagaCompleted": counts["OK"],
        "SagaCompensated": counts["COMPENSATED_OK"],
        "SagaInFlight": counts["IN_FLIGHT"],
        "SagaOrphaned": counts["ORPHANED"],
        "SagaNeedsAttention": counts["NEEDS_ATTENTION"],
        "SagaInconsistent": counts["INCONSISTENT"],
    }
    client("cloudwatch").put_metric_data(
        Namespace="AegisVolt/Audit",
        MetricData=[{"MetricName": k, "Dimensions": dims, "Value": v, "Unit": "Count"} for k, v in mapping.items()],
    )


@flow(name="saga-consistency-audit", log_prints=True)
def saga_consistency_audit(
    environments: list[str] = ENVIRONMENTS,
    orphan_after_seconds: int = 120,
    auto_recover: bool = True,
    limit: int = 500,
) -> dict[str, dict[str, int]]:
    logger = get_run_logger()
    report: dict[str, dict[str, int]] = {}
    problems: list[dict[str, Any]] = []

    for env in environments:
        try:
            sagas = load_sagas(env, limit)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Ambiente %s sin tabla de SAGAs accesible: %s", env, exc)
            continue
        results = audit_sagas(env, sagas, orphan_after_seconds)

        for r in [r for r in results if r.classification == "ORPHANED"]:
            if not auto_recover:
                continue
            try:
                outcome = recover_orphan(env, r.saga_id)
                logger.warning("SAGA huerfana %s (%s) recuperada via API %s -> %s", r.saga_id, env, outcome["via"], outcome["status"])
                r.classification = "COMPENSATED_OK" if outcome["status"] == "COMPENSATED" else "NEEDS_ATTENTION"
                r.violations.append(f"Huerfana recuperada automaticamente ({outcome['via']}): {outcome['status']}")
            except Exception as exc:  # noqa: BLE001
                r.violations.append(f"Recuperacion fallida: {exc}")

        counts = summarize(results)
        report[env] = counts
        logger.info("Auditoria %s: %s", env, counts)
        for r in results:
            if r.classification in ("ORPHANED", "NEEDS_ATTENTION", "INCONSISTENT") or r.violations:
                problems.append(
                    {
                        "ambiente": env,
                        "saga_id": r.saga_id,
                        "estado": r.status,
                        "clasificacion": r.classification,
                        "paso_fallido": r.failed_step or "-",
                        "antiguedad_s": r.age_seconds,
                        "detalle": "; ".join(r.violations) or "-",
                    }
                )
        try:
            publish_metrics(env, counts)
        except Exception as exc:  # noqa: BLE001
            logger.warning("No se pudieron publicar metricas: %s", exc)

    summary_rows = [{"ambiente": env, **counts} for env, counts in report.items()]
    create_table_artifact(key="aegisvolt-saga-audit", table=summary_rows, description="Clasificacion de SAGAs por ambiente")
    md = ["# Auditoria de consistencia SAGA", ""]
    md += [
        "| Ambiente | Total | Completadas | Compensadas | En curso | Huerfanas | Requieren atencion | Inconsistentes |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for env, c in report.items():
        md.append(f"| {env} | {c['TOTAL']} | {c['OK']} | {c['COMPENSATED_OK']} | {c['IN_FLIGHT']} | {c['ORPHANED']} | {c['NEEDS_ATTENTION']} | {c['INCONSISTENT']} |")
    md += ["", f"Problemas detectados: **{len(problems)}**"]
    create_markdown_artifact(key="aegisvolt-saga-audit-summary", markdown="\n".join(md), description="Resumen de la auditoria SAGA")
    if problems:
        create_table_artifact(key="aegisvolt-saga-problems", table=problems, description="SAGAs huerfanas, inconsistentes o que requieren atencion")

    bad = sum(c["INCONSISTENT"] + c["NEEDS_ATTENTION"] + c["ORPHANED"] for c in report.values())
    if bad:
        raise RuntimeError(f"{bad} SAGA(s) inconsistentes, huerfanas o que requieren atencion")
    return report
