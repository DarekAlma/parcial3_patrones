"""
Flow saga-runs: cada SAGA terminada aparece como SU PROPIO flow run en Prefect.

La SAGA la ejecuta el orquestador (graphql-gateway), no Prefect. Este flow la
RECONSTRUYE desde su log persistente (aegisvolt-saga-<env>) para que en el
dashboard (Runs) se vea como una ejecucion:

  run "dev · saga-xxxx"   estado Completed | Compensated | SagaFailed
    ├─ task "1 PRICE_QUOTE"          ok
    ├─ task "2 RESERVE_CONNECTOR"    ok
    ├─ task "3 CHARGE_WALLET"        ok
    ├─ task "4 ACTIVATE_CHARGER"     FALLO (rojo, con el error del servicio)
    ├─ task "compensar CHARGE_WALLET"      REFUNDED
    └─ task "compensar RESERVE_CONNECTOR"  RELEASED

El flow padre corre cada minuto y lanza un run hijo por cada SAGA terminal
nueva desde la ultima pasada (marca guardada en una Variable de Prefect por
ambiente). El nombre del run es el sagaId = correlation_id de CloudWatch.
"""
from __future__ import annotations

from typing import Any, Optional

from boto3.dynamodb.types import TypeDeserializer
from prefect import flow, get_run_logger, task
from prefect.states import Completed, Failed
from prefect.variables import Variable

from .audit_rules import TERMINAL, final_state_name, step_outcome
from .aws import ENVIRONMENTS, client, scan_all, table

_des = TypeDeserializer()


def _plain(item: dict) -> dict:
    return {k: _des.deserialize(v) for k, v in item.items()}


def _load_saga(env: str, saga_id: str) -> Optional[dict]:
    res = client("dynamodb").get_item(TableName=table("saga", env), Key={"pk": {"S": f"SAGA#{saga_id}"}, "sk": {"S": "META"}})
    return _plain(res["Item"]) if "Item" in res else None


@task(name="saga-step")
def replay_step(saga_id: str, step: dict) -> str:
    logger = get_run_logger()
    ok, detail = step_outcome(step)
    logger.info(
        "%s [%s] intentos=%s inicio=%s fin=%s -> %s",
        step["name"], step.get("kind"), step.get("attempts"), step.get("startedAt"), step.get("finishedAt"), detail,
    )
    if not ok:
        raise RuntimeError(f"{step['name']}: {detail}")
    return detail


@task(name="saga-compensation")
def replay_compensation(saga_id: str, comp: dict) -> str:
    logger = get_run_logger()
    outcome = comp.get("outcome") or comp.get("status")
    logger.info("Compensacion de %s: %s (intentos=%s, %s)", comp["step"], outcome, comp.get("attempts"), comp.get("at"))
    if comp.get("status") != "SUCCEEDED":
        raise RuntimeError(f"Compensacion de {comp['step']} fallida: {comp.get('error') or outcome}")
    return str(outcome)


@flow(name="saga-run", flow_run_name="{env} · {saga_id}", log_prints=True)
def saga_run(env: str, saga_id: str):
    logger = get_run_logger()
    saga = _load_saga(env, saga_id)
    if saga is None:
        return Failed(message=f"SAGA {saga_id} no encontrada en {table('saga', env)}")
    data = saga.get("input") or {}
    error = saga.get("error") or {}
    logger.info(
        "SAGA %s en %s: flota=%s estacion=%s kwh=%s estado=%s%s",
        saga_id, env, data.get("fleetId"), data.get("stationId"), data.get("kwh"), saga["status"],
        f" | fallo en {error.get('step')}: {error.get('message')}" if error else "",
    )
    for i, step in enumerate(saga.get("steps") or [], start=1):
        if step.get("status") == "PENDING":
            continue  # nunca se ejecuto (la SAGA se detuvo antes)
        replay_step.with_options(task_run_name=f"{i} {step['name']} [{step.get('kind')}]")(saga_id, step, return_state=True)
    for comp in saga.get("compensations") or []:
        replay_compensation.with_options(task_run_name=f"compensar {comp['step']}")(saga_id, comp, return_state=True)

    status = saga["status"]
    message = f"SAGA {status}; correlation_id={saga_id}"
    if status in ("COMPLETED", "COMPENSATED"):
        return Completed(name=final_state_name(status), message=message)
    return Failed(name=final_state_name(status), message=message)


@task(name="new-terminal-sagas", tags=["dynamodb"])
def new_terminal_sagas(env: str, since: Optional[str], first_batch: int) -> list[dict[str, Any]]:
    items = scan_all(table("saga", env), FilterExpression="sk = :m", ExpressionAttributeValues={":m": {"S": "META"}})
    sagas = [_plain(i) for i in items if _des.deserialize(i["status"]) in TERMINAL]
    sagas.sort(key=lambda s: s["createdAt"])
    if since is None:
        return [{"sagaId": s["sagaId"], "createdAt": s["createdAt"]} for s in sagas[-first_batch:]]
    return [{"sagaId": s["sagaId"], "createdAt": s["createdAt"]} for s in sagas if s["createdAt"] > since]


@flow(name="saga-runs", log_prints=True)
def saga_runs(environments: list[str] = ENVIRONMENTS, first_batch: int = 3, max_per_pass: int = 20) -> dict[str, int]:
    """Lanza un run hijo saga-run por cada SAGA terminal nueva desde la ultima pasada."""
    logger = get_run_logger()
    launched: dict[str, int] = {}
    for env in environments:
        marker = f"saga_runs_last_{env}"
        since = Variable.get(marker, default=None)
        try:
            pending = new_terminal_sagas(env, since, first_batch)[:max_per_pass]
        except Exception as exc:  # noqa: BLE001
            logger.warning("Ambiente %s sin tabla de SAGAs accesible: %s", env, exc)
            continue
        for s in pending:
            saga_run(env=env, saga_id=s["sagaId"], return_state=True)
        if pending:
            Variable.set(marker, pending[-1]["createdAt"], overwrite=True)
        launched[env] = len(pending)
        logger.info("Ambiente %s: %d SAGA(s) nuevas publicadas como runs", env, len(pending))
    return launched
