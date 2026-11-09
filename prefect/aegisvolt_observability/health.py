"""
Flow environment-health: monitorea la salud de los tres ambientes (dev, test, prod).

Por ambiente (una task por chequeo, en paralelo entre ambientes):
  - API Gateway -> VPC Link -> NLB -> EKS: GET /health y una query GraphQL real
  - Cluster EKS (estado ACTIVE)
  - Tablas DynamoDB (Database-per-Service) ACTIVE + numero de items
  - Target group del NLB (targets healthy)
  - Alarmas de CloudWatch del ambiente (canary y SAGA)
  - Estado de las feature flags (independiente por ambiente)

Resultado: artifacts en el dashboard de Prefect (tabla de salud + matriz de
flags por ambiente) y metricas en CloudWatch (AegisVolt/Observability).
"""
from __future__ import annotations

import time
from typing import Any

import httpx
from boto3.dynamodb.types import TypeDeserializer
from prefect import flow, get_run_logger, task
from prefect.artifacts import create_markdown_artifact, create_table_artifact

from .aws import ENVIRONMENTS, PROJECT, client, public_api_url, scan_all, table

_des = TypeDeserializer()
SERVICE_TABLES = ["reservations", "billing", "dispatch", "saga", "feature-flags"]


@task(name="check-api-gateway", retries=1, retry_delay_seconds=3, tags=["api"])
def check_api(env: str) -> dict[str, Any]:
    url = public_api_url(env)
    if not url:
        return {"ok": False, "error": "API Gateway no encontrada"}
    try:
        t0 = time.perf_counter()
        health = httpx.get(f"{url}/health", timeout=10).json()
        latency_ms = round((time.perf_counter() - t0) * 1000)
        q = {"query": "{ environment { environment version } stations { id availableConnectors totalConnectors } }"}
        data = httpx.post(f"{url}/graphql", json=q, timeout=15).json()["data"]
        stations = data["stations"]
        return {
            "ok": health.get("status") == "ok" and data["environment"]["environment"] == env,
            "version": health.get("version"),
            "latency_ms": latency_ms,
            "stations": len(stations),
            "available_connectors": sum(s["availableConnectors"] for s in stations),
            "total_connectors": sum(s["totalConnectors"] for s in stations),
        }
    except Exception as exc:  # noqa: BLE001 - se reporta como ambiente no sano
        return {"ok": False, "error": str(exc)[:200]}


@task(name="check-eks-cluster", tags=["eks"])
def check_cluster(env: str) -> dict[str, Any]:
    try:
        c = client("eks").describe_cluster(name=f"{PROJECT}-{env}")["cluster"]
        return {"ok": c["status"] == "ACTIVE", "status": c["status"], "version": c.get("version")}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "status": "MISSING", "error": str(exc)[:200]}


@task(name="check-dynamodb-tables", tags=["dynamodb"])
def check_tables(env: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    ok = True
    for resource in SERVICE_TABLES:
        try:
            t = client("dynamodb").describe_table(TableName=table(resource, env))["Table"]
            out[resource] = {"status": t["TableStatus"], "items": t.get("ItemCount", 0)}
            ok &= t["TableStatus"] == "ACTIVE"
        except Exception:  # noqa: BLE001
            out[resource] = {"status": "MISSING", "items": 0}
            ok = False
    return {"ok": ok, "tables": out}


@task(name="check-nlb-targets", tags=["network"])
def check_nlb(env: str) -> dict[str, Any]:
    try:
        elb = client("elbv2")
        tg = elb.describe_target_groups(Names=[f"{PROJECT}-{env}-tg-graphql"])["TargetGroups"][0]["TargetGroupArn"]
        states = [d["TargetHealth"]["State"] for d in elb.describe_target_health(TargetGroupArn=tg)["TargetHealthDescriptions"]]
        return {"ok": "healthy" in states, "targets": len(states), "healthy": states.count("healthy")}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "targets": 0, "healthy": 0, "error": str(exc)[:200]}


@task(name="check-cloudwatch-alarms", tags=["cloudwatch"])
def check_alarms(env: str) -> dict[str, Any]:
    alarms = client("cloudwatch").describe_alarms(AlarmNamePrefix=f"{PROJECT}-{env}-")["MetricAlarms"]
    firing = [a["AlarmName"] for a in alarms if a["StateValue"] == "ALARM"]
    return {"ok": not firing, "total": len(alarms), "firing": firing}


@task(name="read-feature-flags", tags=["flags"])
def read_flags(env: str) -> dict[str, bool]:
    try:
        items = [{k: _des.deserialize(v) for k, v in i.items()} for i in scan_all(table("feature-flags", env))]
        return {i["flag"]: bool(i["enabled"]) for i in items}
    except Exception:  # noqa: BLE001
        return {}


@task(name="publish-health-metrics", tags=["cloudwatch"])
def publish_metrics(report: dict[str, dict[str, Any]]) -> None:
    data = []
    for env, r in report.items():
        dims = [{"Name": "Environment", "Value": env}]
        data.append({"MetricName": "EnvironmentHealthy", "Dimensions": dims, "Value": 1 if r["healthy"] else 0, "Unit": "Count"})
        if r["api"].get("latency_ms") is not None:
            data.append({"MetricName": "ApiLatencyMs", "Dimensions": dims, "Value": r["api"]["latency_ms"], "Unit": "Milliseconds"})
    client("cloudwatch").put_metric_data(Namespace="AegisVolt/Observability", MetricData=data)


@flow(name="environment-health", log_prints=True)
def environment_health(environments: list[str] = ENVIRONMENTS) -> dict[str, dict[str, Any]]:
    logger = get_run_logger()
    futures = {
        env: {
            "api": check_api.submit(env),
            "cluster": check_cluster.submit(env),
            "tables": check_tables.submit(env),
            "nlb": check_nlb.submit(env),
            "alarms": check_alarms.submit(env),
            "flags": read_flags.submit(env),
        }
        for env in environments
    }
    report: dict[str, dict[str, Any]] = {}
    for env, f in futures.items():
        r = {k: fut.result() for k, fut in f.items()}
        r["healthy"] = all(r[k]["ok"] for k in ("api", "cluster", "tables", "nlb"))
        r["degraded"] = r["healthy"] and not r["alarms"]["ok"]
        report[env] = r
        state = "DEGRADADO" if r["degraded"] else ("SANO" if r["healthy"] else "CAIDO")
        logger.info("Ambiente %s: %s | api=%s cluster=%s nlb=%s alarmas=%s", env, state, r["api"], r["cluster"]["status"], r["nlb"], r["alarms"]["firing"])

    rows = [
        {
            "ambiente": env,
            "estado": "DEGRADADO" if r["degraded"] else ("SANO" if r["healthy"] else "CAIDO"),
            "version": r["api"].get("version", "-"),
            "latencia_api_ms": r["api"].get("latency_ms", "-"),
            "eks": r["cluster"]["status"],
            "nlb_healthy": f'{r["nlb"]["healthy"]}/{r["nlb"]["targets"]}',
            "conectores_libres": f'{r["api"].get("available_connectors", "-")}/{r["api"].get("total_connectors", "-")}',
            "tablas_ok": all(t["status"] == "ACTIVE" for t in r["tables"]["tables"].values()),
            "alarmas_activas": ", ".join(r["alarms"]["firing"]) or "-",
        }
        for env, r in report.items()
    ]
    create_table_artifact(key="aegisvolt-environment-health", table=rows, description="Salud de los ambientes AegisVolt")

    flag_names = sorted({name for r in report.values() for name in r["flags"]})
    md = ["# Feature flags por ambiente", "", "| Flag | " + " | ".join(report) + " |", "|---|" + "---|" * len(report)]
    for name in flag_names:
        md.append(f"| `{name}` | " + " | ".join("ON" if report[e]["flags"].get(name) else "off" for e in report) + " |")
    md += ["", "Cada ambiente lee su propia tabla `aegisvolt-feature-flags-<env>`: el estado es independiente."]
    create_markdown_artifact(key="aegisvolt-feature-flags", markdown="\n".join(md), description="Matriz de flags por ambiente")

    try:
        publish_metrics(report)
    except Exception as exc:  # noqa: BLE001
        logger.warning("No se pudieron publicar metricas en CloudWatch: %s", exc)

    down = [env for env, r in report.items() if not r["healthy"]]
    if down:
        raise RuntimeError(f"Ambientes caidos: {', '.join(down)}")
    return report
