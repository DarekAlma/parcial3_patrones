"""
Reglas de auditoria de la SAGA "Reservar y Activar Carga".

Logica PURA (sin Prefect ni AWS): recibe el registro de la SAGA y los
"hechos" leidos de las tablas de cada microservicio y decide si la
transaccion distribuida quedo consistente. Se prueba con pytest.

Invariantes (consistencia eventual):
  COMPLETED   -> reserva CONFIRMED/COMPLETED, cobro registrado, SIN reembolso,
                 sesion de carga ACTIVE/COMPLETED.
  COMPENSATED -> si hubo cobro DEBE haber reembolso; la reserva no puede seguir
                 HELD/CONFIRMED; el conector no puede seguir bloqueado por la
                 SAGA; la sesion no puede quedar ACTIVE.
  FAILED      -> requiere intervencion (compensacion agotada o fallo post-pivot).
  no terminal -> en curso; si lleva mas de N segundos sin avanzar = HUERFANA.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

TERMINAL = {"COMPLETED", "COMPENSATED", "FAILED"}


@dataclass(frozen=True)
class SagaFacts:
    """Estado observado en las tablas de cada servicio para un sagaId."""

    reservation_status: Optional[str]  # HELD | CONFIRMED | RELEASED | COMPLETED | None
    connector_locked_by_saga: bool  # el conector sigue con reservedBy = sagaId
    charged: bool  # existe TXN#<saga>#CHARGE
    refunded: bool  # existe TXN#<saga>#REFUND
    session_status: Optional[str]  # ACTIVE | COMPLETED | FAILED | None


@dataclass
class AuditResult:
    saga_id: str
    status: str
    classification: str  # OK | COMPENSATED_OK | IN_FLIGHT | ORPHANED | NEEDS_ATTENTION | INCONSISTENT
    violations: list[str] = field(default_factory=list)
    age_seconds: float = 0.0
    failed_step: Optional[str] = None


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def age_seconds(saga: dict, now: datetime) -> float:
    return (now - _parse(saga["updatedAt"])).total_seconds()


def check_consistency(status: str, facts: SagaFacts) -> list[str]:
    """Devuelve las violaciones de los invariantes (lista vacia = consistente)."""
    v: list[str] = []
    if status == "COMPLETED":
        if facts.reservation_status not in ("CONFIRMED", "COMPLETED"):
            v.append(f"SAGA completada pero la reserva esta en {facts.reservation_status}")
        if not facts.charged:
            v.append("SAGA completada sin cobro registrado en billing")
        if facts.refunded:
            v.append("SAGA completada pero billing registra un reembolso")
        if facts.session_status not in ("ACTIVE", "COMPLETED"):
            v.append(f"SAGA completada pero la sesion de carga esta en {facts.session_status}")
    elif status == "COMPENSATED":
        if facts.charged and not facts.refunded:
            v.append("Cobro SIN reembolso: el saldo de la flota quedo retenido")
        if facts.reservation_status in ("HELD", "CONFIRMED"):
            v.append(f"Reserva no liberada ({facts.reservation_status})")
        if facts.connector_locked_by_saga:
            v.append("El conector sigue bloqueado por la SAGA compensada")
        if facts.session_status == "ACTIVE":
            v.append("Sesion de carga ACTIVE en una SAGA compensada")
    return v


def classify(saga: dict, facts: Optional[SagaFacts], now: datetime, orphan_after_seconds: float) -> AuditResult:
    status = saga["status"]
    result = AuditResult(
        saga_id=saga["sagaId"],
        status=status,
        classification="OK",
        age_seconds=round(age_seconds(saga, now), 1),
        failed_step=(saga.get("error") or {}).get("step"),
    )
    if status not in TERMINAL:
        result.classification = "ORPHANED" if result.age_seconds > orphan_after_seconds else "IN_FLIGHT"
        return result
    if status == "FAILED":
        result.classification = "NEEDS_ATTENTION"
        return result
    if facts is not None:
        result.violations = check_consistency(status, facts)
    if result.violations:
        result.classification = "INCONSISTENT"
    elif status == "COMPENSATED":
        result.classification = "COMPENSATED_OK"
    return result


def summarize(results: list[AuditResult]) -> dict[str, int]:
    keys = ["OK", "COMPENSATED_OK", "IN_FLIGHT", "ORPHANED", "NEEDS_ATTENTION", "INCONSISTENT"]
    counts = {k: 0 for k in keys}
    for r in results:
        counts[r.classification] += 1
    counts["TOTAL"] = len(results)
    return counts


def utcnow() -> datetime:
    return datetime.now(timezone.utc)
