# AegisVolt — Tecnologías y qué hace cada una

> Lectura de 15 minutos. Explica **qué es** cada tecnología, **para qué se usa aquí**, **dónde está** en el repositorio y **qué cambia en AWS real**.
> Preguntas y respuestas: [PREGUNTAS-SUSTENTACION.md](PREGUNTAS-SUSTENTACION.md). Demo en vivo: [GUION-DEMO.md](GUION-DEMO.md).

## 1. El sistema en un párrafo

AegisVolt permite a un operador de flota eléctrica **reservar una bahía de carga, retener saldo y activar el cargador**. Esas tres acciones viven en tres microservicios con tres bases de datos distintas, así que no hay una transacción ACID que las cubra: se coordinan con una **SAGA por orquestación**, que deshace lo hecho si un paso falla. Todo existe tres veces, una por ambiente (`dev`, `test`, `prod`), y cada copia está aislada: su workspace de Terraform, su VPC, sus tablas, su clúster y su API Gateway.

```
 Navegador (React)
     │  HTTP · polling GraphQL cada 2–5 s
     ▼
 API Gateway HTTP API  aegisvolt-<env>          ──► GET /, /{proxy+}  → frontend (nginx)
     │  VPC Link (ENIs en subredes privadas)    ──► ANY /graphql      → graphql-gateway
     ▼
 NLB interno ──► NodePort 30080 / 30081 del nodo EKS
     ▼
 ┌──────────────── EKS aegisvolt-<env> · namespace aegisvolt ────────────────┐
 │  graphql-gateway  (esquema GraphQL + orquestador de la SAGA)              │
 │      │ HTTP + x-correlation-id                                            │
 │      ├──► station-reservation-service ──► aegisvolt-reservations-<env>    │
 │      ├──► billing-wallet-service      ──► aegisvolt-billing-<env>         │
 │      └──► energy-dispatch-service     ──► aegisvolt-dispatch-<env>        │
 │  log de la SAGA ──► aegisvolt-saga-<env>     flags ──► aegisvolt-feature-flags-<env>
 └────────────────────────────────────────────────────────────────────────────┘
     │ logs JSON
     ▼
 CloudWatch Logs /aegisvolt/<env>/<servicio> ──► metric filters ──► alarmas (gate del canary)

 Prefect (fuera del clúster) ──► lee los 3 ambientes ──► API privada (VPCE execute-api) para compensar huérfanas
```

## 2. Mapa de tecnologías

| Capa | Tecnología | Para qué | Dónde |
|------|------------|----------|-------|
| Nube | **Floci 2.4.0** (emulador de AWS) | Sustituye a AWS: S3, DynamoDB, EKS, API Gateway, CloudWatch, EC2, IAM | [infra/floci/docker-compose.yml](../infra/floci/docker-compose.yml) |
| IaC | **Terraform ≥ 1.10**, provider AWS `~> 6.0` | Declarar toda la infraestructura | [infra/terraform](../infra/terraform), [infra/bootstrap](../infra/bootstrap) |
| Contenedores | **Docker** (multi-stage) | Empaquetar los 4 servicios y el frontend | [docker/node-service.Dockerfile](../docker/node-service.Dockerfile), [frontend/Dockerfile](../frontend/Dockerfile) |
| Orquestación | **Kubernetes** (EKS → k3s en Floci) + **kustomize** | Ejecutar los pods; base + overlay por ambiente | [k8s/base](../k8s/base), [k8s/overlays](../k8s/overlays) |
| Backend | **TypeScript + Node 22 + Fastify** | Los 3 microservicios | [services](../services), [packages/common](../packages/common) |
| API | **GraphQL (graphql-yoga)** | Esquema unificado y orquestador SAGA | [graphql-gateway](../graphql-gateway) |
| Datos | **DynamoDB** | Una tabla por servicio y por ambiente | [modules/dynamodb](../infra/terraform/modules/dynamodb/main.tf) |
| Flags | Sistema propio sobre DynamoDB | Estado independiente por ambiente | [flags.ts](../packages/common/src/flags.ts), [modules/feature-flags](../infra/terraform/modules/feature-flags/main.tf) |
| Observabilidad | **CloudWatch Logs + métricas + alarmas** | Logs JSON, tasa de error del canary | [logger.ts](../packages/common/src/logger.ts), [modules/observability](../infra/terraform/modules/observability/main.tf) |
| Observabilidad | **Prefect 3.1.15** | Salud de los 3 ambientes y auditoría de SAGAs | [prefect](../prefect) |
| Frontend | **React + Vite + TypeScript**, servido por **nginx** | UI «Surtidor y ticket térmico» | [frontend](../frontend) |
| CI/CD | **GitHub Actions** + runner self-hosted | Pruebas, plan, apply, canary | [.github/workflows](../.github/workflows), [scripts/ci](../scripts/ci) |
| Gobernanza | **GitHub Rulesets** | Proteger `dev`, `test`, `prod` | [protected-env-branches.json](../.github/rulesets/protected-env-branches.json) |
| Pruebas | **Vitest** y **pytest** | Unitarias, integración, E2E | [vitest.config.ts](../vitest.config.ts), [prefect/tests](../prefect/tests) |

## 3. Floci: la «nube» local

- **Qué es:** un emulador de AWS en un contenedor. Expone todos los servicios en `http://localhost:4566`, con credenciales `test/test`. El enunciado lo permite (sección 2.4).
- **Cómo se usa:** el provider de Terraform, la AWS CLI y los SDK apuntan a ese endpoint. Cada clúster EKS que crea Terraform es un **contenedor k3s real** (`floci-aws-eks-aegisvolt-<env>`).
- **Modo `persistent`** ([docker-compose.yml:24](../infra/floci/docker-compose.yml#L24)): sin él, reiniciar Floci borraría el bucket del tfstate y sus versiones.
- **Lo que Floci no hace** (y hay que decirlo si preguntan):

| Límite de Floci | Qué está declarado en el código | En AWS real |
|-----------------|--------------------------------|-------------|
| No materializa la ruta prefix-list del Gateway VPCE | Asociación del endpoint con `rt-private` | Aparece `pl-xxxx → vpce-xxxx` en la tabla de rutas |
| No evalúa resource policies | API privada con `Allow`/`Deny` por `aws:SourceVpce` | La API ni resuelve fuera de la VPC |
| No valida firmas IAM | Roles de mínimo privilegio + Pod Identity | El Secret `test/test` desaparece |
| Un solo nodo k3s por clúster | `desired_size = 2` en prod | Dos nodos en dos zonas |

## 4. Terraform

- **Dos stacks.** [infra/bootstrap](../infra/bootstrap/main.tf) crea el bucket `aegisvolt-tfstate` (versioning, cifrado, sin acceso público). [infra/terraform](../infra/terraform/main.tf) es el **único root module** de la plataforma.
- **Backend remoto en S3** ([versions.tf:28-34](../infra/terraform/versions.tf#L28)): `workspace_key_prefix = "env:"` produce una key por workspace: `env:/dev/aegisvolt/terraform.tfstate`, `env:/test/...`, `env:/prod/...`. `use_lockfile = true` bloquea el estado con un archivo `.tflock` en el mismo bucket.
- **Workspaces = ambientes.** El ambiente no es una variable: es `terraform.workspace` ([locals.tf:9](../infra/terraform/locals.tf#L9)). Todos los nombres salen de ahí.
- **Dos guardas** ([locals.tf:50-63](../infra/terraform/locals.tf#L50)): el workspace debe ser `dev|test|prod`, y el `tfvars` debe declarar el mismo ambiente que el workspace activo.
- **Siete módulos** en [modules/](../infra/terraform/modules):

| Módulo | Crea |
|--------|------|
| `network` | VPC, 2 subredes públicas y 2 privadas, IGW, tablas de rutas, Gateway VPCE (S3, DynamoDB) con policy por ambiente, Interface VPCE (`execute-api`, `logs`, `monitoring`, `sts`, `ecr.api`, `ecr.dkr`, `eks`) |
| `dynamodb` | Una tabla `pk/sk` con GSI y TTL opcionales |
| `feature-flags` | Tabla de flags y sus valores iniciales |
| `eks` | Clúster, node group, security groups, un rol IAM por servicio con Pod Identity |
| `api-gateway` | HTTP API pública, VPC Link, NLB interno, target groups, API REST privada con resource policy |
| `observability` | Log groups, metric filters y alarmas |
| `ecr` | Un repositorio de imágenes por servicio |

- **Diferencias por ambiente** en [environments/*.tfvars](../infra/terraform/environments): CIDR de la VPC, tamaño del node group, límites de throttling, retención de logs, protección de borrado y valor inicial de las flags.

## 5. Red: VPC, subredes y VPC Endpoints

- **Subredes privadas sin salida a Internet:** `rt-private` solo tiene la ruta `local` ([network/main.tf:83-92](../infra/terraform/modules/network/main.tf#L83)). No hay NAT.
- **Gateway VPCE** (S3 y DynamoDB): funcionan por tabla de rutas. Su policy solo permite tablas `aegisvolt-*-<env>` ([network/main.tf:106-118](../infra/terraform/modules/network/main.tf#L106)): un pod de `test` no puede leer una tabla de `prod` ni aunque tuviera credenciales.
- **Interface VPCE:** una ENI por subred privada con DNS privado. `sg-vpce` solo acepta 443 desde la VPC.
- **Entrada pública:** cliente → API Gateway HTTP API → **VPC Link** → **NLB interno** → NodePort → pod.
- **Entrada privada:** workload de la VPC → **Interface VPCE `execute-api`** → API REST `PRIVATE` → VPC Link → NLB → pod. La usa Prefect para compensar SAGAs huérfanas.
- **Cadena de security groups:** `sg-vpclink` → `sg-nlb` → `sg-nodes`, cada uno abre solo el puerto del siguiente ([api-gateway/main.tf:30-96](../infra/terraform/modules/api-gateway/main.tf#L30)).

## 6. DynamoDB

- **Database-per-Service:** cada servicio es dueño de una tabla y ninguno lee la de otro. La consistencia entre tablas la da la SAGA.
- **Cinco tablas por ambiente:** `reservations`, `billing`, `dispatch`, `saga` (log del orquestador) y `feature-flags`.
- **Diseño de una sola tabla por servicio** (`pk`/`sk`). Ejemplo de billing: `WALLET#<flota> | META` es la billetera y `WALLET#<flota> | TXN#<sagaId>#CHARGE` es el cobro.
- **Escrituras condicionales:** `attribute_not_exists` y `TransactWriteItems` dan idempotencia y atomicidad dentro de un servicio.
- **TTL:** vence solos los bloqueos de bahía y la telemetría de más de 24 h.
- **IAM por servicio** ([main.tf:68-89](../infra/terraform/main.tf#L68)): cada ServiceAccount escribe solo en su tabla y lee la de flags.

## 7. Microservicios (TypeScript + Fastify)

| Servicio | Responsabilidad | Endpoints clave |
|----------|-----------------|-----------------|
| `station-reservation-service` | Disponibilidad y bloqueo temporal de bahías | `POST /reservations`, liberar, confirmar |
| `billing-wallet-service` | Cotización, cobro y reembolso | `POST /charges`, `POST /charges/:sagaId/refund` |
| `energy-dispatch-service` | Activar el cargador y registrar telemetría | `POST /sessions`, `GET /telemetry/:stationId` |

- **Código común** en [packages/common](../packages/common/src): servidor HTTP con `/health` y `/ready` ([server.ts](../packages/common/src/server.ts)), logger JSON, cliente HTTP con timeout y reintentos, cliente de flags.
- **Una sola imagen Docker genérica** ([node-service.Dockerfile](../docker/node-service.Dockerfile)): multi-stage, usuario no root, `HEALTHCHECK`. El servicio se elige con `ARG SERVICE`.
- **La misma imagen se promueve** entre ambientes. Lo único que cambia es el ConfigMap del overlay.

## 8. GraphQL

- **Un esquema unificado** en [schema.graphql](../graphql-gateway/src/schema.graphql): 11 queries y 4 mutations. Agrega los tres servicios detrás de un solo endpoint `/graphql`.
- **Servidor:** graphql-yoga montado sobre Fastify ([app.ts:23](../graphql-gateway/src/app.ts#L23)). GraphiQL está activo en dev y test, apagado en prod.
- **Mutation principal:** `reserveAndActivateCharge` ([resolvers.ts:133](../graphql-gateway/src/resolvers.ts#L133)) dispara la SAGA y **siempre devuelve la transacción**, con estado `COMPLETED`, `COMPENSATED` o `FAILED`. Un fallo de negocio no es un error GraphQL.

## 9. SAGA por orquestación

- **Quién orquesta:** `graphql-gateway`. Conoce la secuencia, llama a cada servicio y guarda cada transición en `aegisvolt-saga-<env>` antes de continuar.
- **Pasos** ([reserve-charge-saga.ts](../graphql-gateway/src/saga/reserve-charge-saga.ts)):

| # | Paso | Servicio | Tipo | Compensación |
|---|------|----------|------|--------------|
| 0 | `PRICE_QUOTE` | billing | compensable | ninguna (solo lee) |
| 1 | `RESERVE_CONNECTOR` | station | compensable | liberar → `AVAILABLE` |
| 2 | `CHARGE_WALLET` | billing | compensable | reembolso + evento `REFUND` |
| 3 | `ACTIVATE_CHARGER` | dispatch | **pivot** | — |
| 4 | `CONFIRM_RESERVATION` | station | retriable | — (se reintenta) |

- **Compensación en orden inverso** ([engine.ts:176](../graphql-gateway/src/saga/engine.ts#L176)): falla el paso 3 → reembolso → liberación. Falla el paso 2 → solo liberación.
- **Idempotencia:** el `sagaId` forma parte de la clave de cada escritura. Repetir un reembolso devuelve `ALREADY_REFUNDED` sin mover saldo ([repository.ts:159-209](../services/billing-wallet-service/src/repository.ts#L159)).
- **Fallos ambiguos** ([engine.ts:118-122](../graphql-gateway/src/saga/engine.ts#L118)): si un paso falla por timeout o 5xx, el servicio pudo haber aplicado el efecto. El motor compensa también ese paso; si no había nada que deshacer, la compensación responde `NOTHING_TO_*`.
- **Recuperación** ([engine.ts:232](../graphql-gateway/src/saga/engine.ts#L232)): `recoverTransaction` compensa una SAGA que quedó a medias porque el orquestador murió.
- **`correlation_id` = `sagaId`:** viaja en el header `x-correlation-id` a los tres servicios.

## 10. Feature flags

- **Dónde viven:** tabla `aegisvolt-feature-flags-<env>`. Terraform siembra el valor inicial e **ignora cambios posteriores** ([feature-flags/main.tf:41-43](../infra/terraform/modules/feature-flags/main.tf#L41)), así un `apply` no revierte un cambio hecho en caliente.
- **Cómo se leen:** cada pod consulta la tabla con cache de 3 s ([flags.ts:42-53](../packages/common/src/flags.ts#L42)). Un cambio se propaga en ≤ 3 s sin redesplegar.

| Flag | Efecto | Dónde se evalúa |
|------|--------|-----------------|
| `ENABLE_DYNAMIC_SURGE_PRICING` | Precio × 1.5 en horas pico | [pricing.ts](../services/billing-wallet-service/src/pricing.ts) |
| `ENABLE_FAST_CHARGE_BOOST` | Permite la reserva prioritaria de ultra-carga | [station/app.ts:62](../services/station-reservation-service/src/app.ts#L62) |
| `SIMULATE_CHARGER_HARDWARE_FAULT` | El cargador reporta falla y dispara el rollback | [dispatch/app.ts:47](../services/energy-dispatch-service/src/app.ts#L47) |

- **En prod** la mutation `setFeatureFlag` está bloqueada (`FLAG_ADMIN_ENABLED=false` en el overlay).

## 11. Kubernetes y canary

- **kustomize:** [k8s/base](../k8s/base) define todo; cada overlay solo cambia el ConfigMap del ambiente.
- **Dos Deployments por servicio:** `stable` (4 réplicas) y `canary` (0 en reposo), con el **mismo label** `app.kubernetes.io/name`. El Service selecciona por ese label, así que reparte entre todos los pods listos: 1 canary + 4 stable = **20% al canary**.
- **Sin caída:** `RollingUpdate` con `maxUnavailable: 0`.
- **Endurecimiento:** usuario no root, sistema de archivos de solo lectura, sin capabilities, NetworkPolicy que solo deja entrar al gateway.
- **Canary** ([canary-deploy.ps1](../scripts/ci/canary-deploy.ps1)): levanta 1 pod canary, envía tráfico sintético, lee CloudWatch y decide.

| Condición del gate (todas) | Fuente |
|----------------------------|--------|
| Canary `Ready` y sin reinicios | Kubernetes |
| `RequestCount(Track=canary) ≥ 5` | CloudWatch |
| `ErrorCount / RequestCount ≤ 5%` | CloudWatch |
| Alarma `…-canary-errors` distinta de `ALARM` | CloudWatch |

- **Si pasa:** stable adopta la imagen nueva con rolling update y el canary vuelve a 0. **Si falla:** el canary vuelve a 0, stable queda intacto y el job falla.

## 12. CI/CD y gobernanza de Git

- **Ramas:** `dev`, `test`, `prod`. El ruleset no tiene bypass y prohíbe borrar, force push y push directo; exige 6 checks y solo permite merge commit.
- **Promoción lineal:** `feature/* → dev → test → prod`. El job `promotion-guard` rechaza cualquier otro origen ([ci.yml:46-70](../.github/workflows/ci.yml#L46)).

| Momento | Workflow | Jobs |
|---------|----------|------|
| Pull request | [ci.yml](../.github/workflows/ci.yml) | `promotion-guard` → `lint-build` → `unit-tests` → `integration-tests` → `e2e-tests`, y `terraform-plan` sobre el workspace de la rama destino |
| Merge | [cd.yml](../.github/workflows/cd.yml) | `resolve-env` → `terraform-apply` → `k8s-apply` → `canary-deploy` por servicio |

- **Ambiente dinámico:** en CI es `github.base_ref` (rama destino del PR); en CD es `github.ref_name` (rama que recibió el merge).
- **Runner self-hosted** con etiqueta `aegisvolt`, porque Floci vive en `localhost`. Los scripts son PowerShell 5.1.

## 13. Observabilidad

- **Logs JSON** con `timestamp`, `level`, `service`, `environment`, `track`, `version` y `correlation_id` ([logger.ts:96-104](../packages/common/src/logger.ts#L96)). El logger los envía por lotes cada 2 s a `/aegisvolt/<env>/<servicio>`.
- **Metric filters** ([observability/main.tf:27-32](../infra/terraform/modules/observability/main.tf#L27)): `RequestCount`, `ErrorCount`, `SagaCompensated`, `SagaFailed`, con dimensiones `Service` y `Track`.
- **Alarmas:** una por servicio para los errores del canary y una de negocio para SAGAs fallidas.
- **Prefect** ([prefect/aegisvolt_observability](../prefect/aegisvolt_observability)):

| Flow | Qué hace | Frecuencia |
|------|----------|-----------|
| `environment-health` | API Gateway, clúster, tablas, targets del NLB, alarmas y flags de los 3 ambientes | 2 min |
| `saga-consistency-audit` | Cruza el log de cada SAGA con las tablas de los 3 servicios; detecta huérfanas e inconsistentes; compensa huérfanas por la API privada | 5 min |
| `aegisvolt-observability` | Ejecuta los dos anteriores | bajo demanda |

- Publica **artifacts** en el dashboard (tablas y Markdown) y métricas en `AegisVolt/Audit`.

## 14. Frontend

- **React + Vite + TypeScript**, empaquetado en nginx sin privilegios.
- **Mismo origen que la API:** se sirve por el API Gateway del ambiente (`GET /` y `GET /{proxy+}`), así `/graphql` no necesita CORS.
- **Tiempo real por polling** ([graphql.ts:33-77](../frontend/src/lib/graphql.ts#L33)): estaciones cada 3 s, telemetría cada 2 s, flags cada 4 s, historial cada 5 s.
- **Cuatro funciones del enunciado:**

| Requisito | Componente |
|-----------|-----------|
| Panel de electrolineras y conectores | [StationRail](../frontend/src/components/StationRail.tsx), [Dispenser](../frontend/src/components/Dispenser.tsx) |
| Flujo de reserva y activación | [Dispenser.tsx:84](../frontend/src/components/Dispenser.tsx#L84) |
| Flags del ambiente y de los otros dos | [ServiceCabinet](../frontend/src/components/ServiceCabinet.tsx) |
| Historial y compensaciones | [Ticket](../frontend/src/components/Ticket.tsx), [TicketRoll](../frontend/src/components/TicketRoll.tsx) |

## 15. Pruebas

| Suite | Cantidad | Contra qué corre |
|-------|----------|------------------|
| Unitarias (Vitest) | 31 | Nada externo: motor SAGA, reglas de negocio, precios |
| Unitarias (pytest) | 10 | Reglas de auditoría de Prefect |
| Integración | 25 | DynamoDB real en Floci, tablas efímeras `aegisvolt-it-*` |
| E2E | 7 | Los 4 servicios como procesos + GraphQL |

```powershell
npm run test:unit
npm run test:integration
npm run test:e2e
```
