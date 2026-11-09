from datetime import datetime, timedelta, timezone

from aegisvolt_observability.audit_rules import SagaFacts, check_consistency, classify, summarize

NOW = datetime(2026, 11, 9, 19, 0, tzinfo=timezone.utc)


def saga(status: str, age_s: float = 10, step=None) -> dict:
    ts = (NOW - timedelta(seconds=age_s)).isoformat().replace("+00:00", "Z")
    return {"sagaId": f"saga-{status.lower()}", "status": status, "updatedAt": ts, "error": {"step": step} if step else None}


def facts(**over) -> SagaFacts:
    base = dict(reservation_status="CONFIRMED", connector_locked_by_saga=True, charged=True, refunded=False, session_status="ACTIVE")
    base.update(over)
    return SagaFacts(**base)


def test_completed_consistente():
    r = classify(saga("COMPLETED"), facts(), NOW, 120)
    assert r.classification == "OK" and r.violations == []


def test_completed_con_reembolso_es_inconsistente():
    v = check_consistency("COMPLETED", facts(refunded=True))
    assert any("reembolso" in x for x in v)


def test_compensated_correcto_hubo_cobro_y_reembolso():
    f = facts(reservation_status="RELEASED", connector_locked_by_saga=False, refunded=True, session_status="FAILED")
    r = classify(saga("COMPENSATED", step="ACTIVATE_CHARGER"), f, NOW, 120)
    assert r.classification == "COMPENSATED_OK"
    assert r.failed_step == "ACTIVATE_CHARGER"


def test_compensated_por_fondos_insuficientes_sin_cobro_es_valido():
    f = facts(reservation_status="RELEASED", connector_locked_by_saga=False, charged=False, refunded=False, session_status=None)
    assert check_consistency("COMPENSATED", f) == []


def test_compensated_con_cobro_sin_reembolso_es_inconsistente():
    f = facts(reservation_status="RELEASED", connector_locked_by_saga=False, refunded=False, session_status="FAILED")
    r = classify(saga("COMPENSATED"), f, NOW, 120)
    assert r.classification == "INCONSISTENT"
    assert any("SIN reembolso" in x for x in r.violations)


def test_compensated_con_bahia_bloqueada_es_inconsistente():
    f = facts(reservation_status="HELD", connector_locked_by_saga=True, charged=False, session_status=None)
    v = check_consistency("COMPENSATED", f)
    assert len(v) == 2  # reserva no liberada + conector bloqueado


def test_saga_no_terminal_reciente_esta_en_curso():
    assert classify(saga("CHARGED", age_s=30), None, NOW, 120).classification == "IN_FLIGHT"


def test_saga_no_terminal_vieja_es_huerfana():
    r = classify(saga("CHARGED", age_s=600), None, NOW, 120)
    assert r.classification == "ORPHANED" and r.age_seconds == 600


def test_failed_requiere_atencion():
    assert classify(saga("FAILED"), None, NOW, 120).classification == "NEEDS_ATTENTION"


def test_summarize_cuenta_por_clasificacion():
    results = [
        classify(saga("COMPLETED"), facts(), NOW, 120),
        classify(saga("FAILED"), None, NOW, 120),
        classify(saga("RESERVED", age_s=999), None, NOW, 120),
    ]
    counts = summarize(results)
    assert counts == {"OK": 1, "COMPENSATED_OK": 0, "IN_FLIGHT": 0, "ORPHANED": 1, "NEEDS_ATTENTION": 1, "INCONSISTENT": 0, "TOTAL": 3}
