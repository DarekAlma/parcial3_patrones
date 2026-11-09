# Capa 4 — Observabilidad: CloudWatch + Prefect (12%)

## Mapa rápido

| Qué | Dónde |
|-----|-------|
| Logger JSON con `correlation_id` (todos los servicios) | [packages/common/src/logger.ts](../../packages/common/src/logger.ts) |
| Propagación del `correlation_id` (header `x-correlation-id`) | [packages/common/src/server.ts](../../packages/common/src/server.ts), [http-client.ts](../../packages/common/src/http-client.ts) |
| Log groups, metric filters y alarmas por ambiente | [infra/terraform/modules/observability/main.tf](../../infra/terraform/modules/observability/main.tf) |
| **Flow de salud de ambientes** | [prefect/aegisvolt_observability/health.py](../../prefect/aegisvolt_observability/health.py) |
| **Flow de auditoría SAGA** | [prefect/aegisvolt_observability/saga_audit.py](../../prefect/aegisvolt_observability/saga_audit.py) |
| Reglas de consistencia (lógica pura + pytest) | [prefect/aegisvolt_observability/audit_rules.py](../../prefect/aegisvolt_observability/audit_rules.py), [tests](../../prefect/tests/test_audit_rules.py) |
| Deployments programados | [prefect/aegisvolt_observability/serve.py](../../prefect/aegisvolt_observability/serve.py) |
| Prefect server + worker | [prefect/docker-compose.yml](../../prefect/docker-compose.yml) |
| Rastrear una SAGA en CloudWatch | [scripts/demo/trace-saga.ps1](../../scripts/demo/trace-saga.ps1) |
| Fabricar una SAGA huérfana (demo) | [scripts/demo/create-orphan-saga.ps1](../../scripts/demo/create-orphan-saga.ps1) |

## CloudWatch

**Logs estructurados.** Cada línea de log es JSON con un conjunto fijo de campos:
```json
{"timestamp":"2026-11-09T18:36:53.796Z","level":"WARN","service":"energy-dispatch-service",
 "environment":"dev","track":"stable","version":"v-17b46dae4520",
 "correlation_id":"saga-a9fe71f2-...","event":"charger_fault","fault_code":"CHARGER_HARDWARE_FAULT",
 "message":"charger reported hardware fault"}
```
- El **`correlation_id` es el `sagaId`**. El gateway lo genera, lo envía a cada servicio en `x-correlation-id`, y el servidor HTTP común lo agrega a todos los logs de esa petición.
- Cada pod envía sus logs por lote a **`/aegisvolt/<env>/<servicio>`**, en el stream `<pod>-<track>`. Así cada ambiente tiene grupos de logs separados.

**Métricas** (metric filters de Terraform → namespace `AegisVolt/<env>`, dimensiones `Service` y `Track`):

| Métrica | Filtro | Uso |
|---------|--------|-----|
| `RequestCount` | `{ $.event = "http_request" }` | Denominador de la tasa de error del canary |
| `ErrorCount` | `{ $.level = "ERROR" }` (respuestas 5xx) | Gate del canary + alarma `...-canary-errors` |
| `SagaCompensated` | `{ $.event = "saga_compensated" }` | Rollbacks de negocio |
| `SagaFailed` | `{ $.event = "saga_failed" }` | Alarma `aegisvolt-<env>-saga-failed` |

Prefect publica además `AegisVolt/Observability` (`EnvironmentHealthy`, `ApiLatencyMs`) y `AegisVolt/Audit` (`SagaOrphaned`, `SagaInconsistent`, ...), con dimensión `Environment`.

## Prefect

Hay dos contenedores (`prefect/docker-compose.yml`):
- **`prefect-server`**: la API y el dashboard en http://localhost:4200.
- **`prefect-observer`**: publica los flows como **deployments programados** (`prefect serve`) y los ejecuta. Vive en la red Docker `aegisvolt` y llega a Floci como `http://floci:4566`.

| Deployment | Frecuencia | Qué hace |
|------------|-----------|----------|
| `environment-health/every-2-minutes` | 2 min | Salud de **dev, test y prod** |
| `saga-consistency-audit/every-5-minutes` | 5 min | Audita las SAGAs de los 3 ambientes y recupera huérfanas |
| `aegisvolt-observability/on-demand` | manual | Flow padre que corre los dos como subflows (demo) |

### Flow `environment-health`

Por ambiente lanza 6 tasks en paralelo:

| Task | Verifica |
|------|----------|
| `check-api-gateway` | `GET /health` y una query GraphQL real **a través de API Gateway → VPC Link → NLB → EKS**; mide la latencia |
| `check-eks-cluster` | El clúster `aegisvolt-<env>` está `ACTIVE` |
| `check-dynamodb-tables` | Las 5 tablas del ambiente están `ACTIVE`, con su número de items |
| `check-nlb-targets` | El target group del NLB tiene targets `healthy` |
| `check-cloudwatch-alarms` | Alarmas del ambiente en `ALARM` (canary, SAGA) → el ambiente se marca "DEGRADADO" |
| `read-feature-flags` | Estado de las flags del ambiente |

**Resultados en el dashboard:**
- **Artifact `aegisvolt-environment-health`**: tabla con estado, versión desplegada, latencia, EKS, NLB, conectores libres y alarmas.
- **Artifact `aegisvolt-feature-flags`**: matriz flag × ambiente. Muestra que cada ambiente tiene su **propio** estado.
- Si un ambiente está caído, el flow termina en **Failed** y aparece en rojo.

### Flow `saga-consistency-audit`

1. Lee el log de SAGAs de cada ambiente (`aegisvolt-saga-<env>`).
2. Para cada SAGA terminal, cruza su estado con **las tablas de los 3 servicios** y verifica los invariantes ([audit_rules.py](../../prefect/aegisvolt_observability/audit_rules.py)):
   - `COMPLETED` ⇒ reserva `CONFIRMED`/`COMPLETED`, cobro registrado, **sin** reembolso y sesión `ACTIVE`/`COMPLETED`.
   - `COMPENSATED` ⇒ si hubo cobro **debe** haber reembolso, la reserva no puede seguir `HELD`/`CONFIRMED`, el conector no puede seguir bloqueado por esa SAGA y la sesión no puede quedar `ACTIVE`.
3. Clasifica cada SAGA:

   | Clasificación | Criterio |
   |---------------|----------|
   | `OK` | Completada y consistente |
   | `COMPENSATED_OK` | Rollback correcto |
   | `IN_FLIGHT` | Todavía en curso |
   | `ORPHANED` | **Huérfana**: no terminal y sin avanzar más de 120 s |
   | `NEEDS_ATTENTION` | `FAILED` |
   | `INCONSISTENT` | Viola algún invariante |

4. **Auto-remediación:** a cada huérfana le aplica `recoverTransaction(sagaId)` por la **API interna PRIVADA** (REST `PRIVATE`, que en AWS solo es alcanzable vía el VPCE `execute-api`). Si esa ruta no responde, usa la pública.
5. Publica artifacts (`aegisvolt-saga-audit`, `aegisvolt-saga-audit-summary`, `aegisvolt-saga-problems`) y métricas `AegisVolt/Audit`. Si quedan problemas, el flow termina en **Failed**.

---

## Pregunta guía 1

### Muestre en Prefect la ejecución del flujo de observabilidad y rastree en CloudWatch el `correlation_id` de una transacción SAGA fallida.

**Respuesta corta:**
1. En Prefect (http://localhost:4200) ejecuto el deployment `aegisvolt-observability/on-demand`.
2. Muestro el flow run con sus subflows `environment-health` y `saga-consistency-audit`, sus tasks por ambiente y los artifacts (tabla de salud, matriz de flags y auditoría de SAGAs).
3. Tomo el `sagaId` de una SAGA compensada (que también es su `correlation_id`).
4. Con Logs Insights consulto los 4 log groups `/aegisvolt/dev/*`. Sale la línea de tiempo completa: falla del cargador, reembolso en billing y liberación en station.

**Paso a paso:**
```powershell
# 0. (si no esta arriba) Prefect
docker compose -f prefect/docker-compose.yml up -d --build

# 1. Provocar una SAGA fallida en dev (flag de fallo + mutation)
$API = "http://localhost:4566/execute-api/$(aws apigatewayv2 get-apis --query "Items[?Name=='aegisvolt-dev'].ApiId|[0]" --output text)/`$default"
$m = { param($q) Invoke-RestMethod -Method Post -Uri "$API/graphql" -ContentType application/json -Body (@{query=$q}|ConvertTo-Json -Compress) }
& $m 'mutation { setFeatureFlag(name:"SIMULATE_CHARGER_HARDWARE_FAULT", enabled:true) { enabled } }'
Start-Sleep 4
(& $m 'mutation { reserveAndActivateCharge(input:{fleetId:"fleet-andina", stationId:"st-bog-norte", kwh:20}) { sagaId status } }').data
& $m 'mutation { setFeatureFlag(name:"SIMULATE_CHARGER_HARDWARE_FAULT", enabled:false) { enabled } }'

# 2. Ejecutar el flujo de observabilidad y abrir el dashboard
docker exec aegisvolt-prefect-prefect-observer-1 prefect deployment run "aegisvolt-observability/on-demand"
start http://localhost:4200/runs          # flow runs, subflows, tasks y artifacts

# 3. Rastrear la SAGA fallida en CloudWatch por correlation_id (Logs Insights sobre 4 log groups)
.\scripts\demo\trace-saga.ps1 -Environment dev -LastFailed
```

**Salida real de `trace-saga.ps1`** (SAGA `saga-a9fe71f2-…`, 24 eventos de 4 servicios):
```
hora         service                     level event
18:36:53.739 graphql-gateway             INFO  saga_started
18:36:53.757 station-reservation-service INFO  reservation_held
18:36:53.771 billing-wallet-service      INFO  wallet_charged
18:36:53.796 energy-dispatch-service     WARN  charger_fault          <- falla fisica (Paso 3)
18:36:53.798 graphql-gateway             WARN  saga_step_failed
18:36:53.801 graphql-gateway             INFO  saga_compensation_started
18:36:53.814 billing-wallet-service      INFO  wallet_refund          <- compensacion 1 (reembolso)
18:36:53.828 station-reservation-service INFO  reservation_released   <- compensacion 2 (liberacion)
18:36:53.835 graphql-gateway             INFO  saga_compensated
```

**La misma consulta en Logs Insights:**
```
fields @timestamp, service, level, event, message
| filter correlation_id = 'saga-a9fe71f2-4d0c-4849-8b72-0651a711d5c5'
| sort @timestamp asc
```
Log groups: `/aegisvolt/dev/graphql-gateway`, `/aegisvolt/dev/station-reservation-service`, `/aegisvolt/dev/billing-wallet-service`, `/aegisvolt/dev/energy-dispatch-service`.

Alternativa con la CLI, servicio por servicio:
```powershell
aws logs filter-log-events --log-group-name /aegisvolt/dev/billing-wallet-service `
  --filter-pattern '{ $.correlation_id = "saga-a9fe71f2-4d0c-4849-8b72-0651a711d5c5" }' --query "events[].message"
```

---

## Demo extra: SAGA huérfana detectada y compensada por Prefect

Demuestra el caso "auditar transacciones huérfanas" del enunciado:
```powershell
# El orquestador "muere" despues del Paso 1: la bahia queda RESERVED y la SAGA sin terminar
.\scripts\demo\create-orphan-saga.ps1 -Environment dev
#  SAGA huerfana creada en dev: {"sagaId":"saga-orphan-f66a4e34","connectorId":"c1","status":"RESERVED (huerfana)"}

docker exec aegisvolt-prefect-prefect-observer-1 prefect deployment run "saga-consistency-audit/every-5-minutes"
#  WARNING | SAGA huerfana saga-orphan-f66a4e34 (dev) recuperada via API private -> COMPENSATED
#  Auditoria dev: {'OK': 1, 'COMPENSATED_OK': 2, 'ORPHANED': 0, 'INCONSISTENT': 0, 'TOTAL': 3}
```

Resultado verificado en DynamoDB: el conector `st-cdmx-vallejo/c1` volvió a `AVAILABLE` sin `reservedBy`, y la SAGA quedó `COMPENSATED` con el error `ORPHANED_SAGA`.

---

## Otras preguntas probables

**¿Por qué el `correlation_id` es el `sagaId` y no un id por request?** Porque la unidad que se quiere rastrear es la **transacción de negocio**, que cruza 4 servicios y varias requests HTTP. Con un único id, la consulta de una sola SAGA trae todo: pasos, reintentos y compensaciones. Las requests que no son SAGA (consultas) usan el id de la request.

**¿Por qué hay log groups separados por ambiente?** Para el aislamiento y el control de acceso: una policy IAM puede dar acceso a `/aegisvolt/dev/*` sin exponer `/aegisvolt/prod/*`. También permite retención distinta (dev 7 días, test 14, prod 30) y métricas independientes, porque los metric filters son por log group.

**¿Qué pasa si CloudWatch no responde?** El logger escribe siempre a stdout y envía a CloudWatch en lotes cada 2 s. Si el envío falla, no tumba el servicio: escribe el error en stderr y reintenta el siguiente lote. La observabilidad nunca debe afectar la disponibilidad.

**¿Qué aporta Prefect frente a solo CloudWatch?**
- CloudWatch ve **eventos aislados**: logs y métricas por servicio.
- Prefect ejecuta **verificaciones activas y cruzadas**: llama a la API de punta a punta y compara el log de la SAGA contra 3 tablas de 3 servicios distintos. Encuentra inconsistencias que ningún servicio puede ver solo, como un cobro sin reembolso.
- Además deja historial de corridas, reintentos de tasks, programación y artifacts en un dashboard.

**¿Por qué las reglas de auditoría son lógica pura?** Para probarlas sin infraestructura. Los 10 tests de [test_audit_rules.py](../../prefect/tests/test_audit_rules.py) cubren cada invariante, las huérfanas y el resumen, y corren en el job `unit-tests` del CI.

**¿Cómo se diferencia una SAGA "en curso" de una "huérfana"?** Por la antigüedad de `updatedAt`. El orquestador persiste cada transición, así que una SAGA viva actualiza ese campo en milisegundos. Si una SAGA no terminal lleva más de 120 s sin cambios (`orphan_after_seconds`, parametrizable), el orquestador murió a mitad de camino.

**¿Por qué la recuperación usa la API privada?** Porque es una operación **interna y administrativa** que no debe estar expuesta a Internet. La REST API `PRIVATE` tiene una resource policy que solo acepta tráfico con `aws:SourceVpce` igual al VPCE del ambiente. En AWS real, el worker de Prefect correría dentro de la VPC.
