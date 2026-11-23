# AegisVolt — Documento completo de sustentación

> **Qué es este documento.** Todo lo que se construyó, para qué se construyó cada pieza, cómo cumple el enunciado y dónde está el código. Después vienen las preguntas probables del profesor, con su respuesta y su explicación, y las demostraciones en vivo con los comandos exactos.
>
> **Cómo se califica.** Cada pregunta vale todo o nada. Por eso cada respuesta empieza con **una frase que ya es correcta por sí sola**; la explicación y el código vienen después, para cuando el profesor pida profundizar.
>
> **Documentos relacionados:** el guion cronometrado de la demo en [GUION-DEMO.md](GUION-DEMO.md); las guías largas por capa en [sustentacion/](sustentacion/); el glosario de tecnologías en [TECNOLOGIAS.md](TECNOLOGIAS.md).

## Índice

1. [El proyecto en dos minutos](#1-el-proyecto-en-dos-minutos)
2. [Capa 1 — IaC, S3, redes y DynamoDB (30%)](#2-capa-1--iac-s3-redes-y-dynamodb-30)
3. [Capa 2 — CI/CD, gobernanza de Git y canary (25%)](#3-capa-2--cicd-gobernanza-de-git-y-canary-25)
4. [Capa 3 — Backend, Kubernetes, GraphQL, SAGA y flags (25%)](#4-capa-3--backend-kubernetes-graphql-saga-y-flags-25)
5. [Capa 4 — Observabilidad: CloudWatch y Prefect (12%)](#5-capa-4--observabilidad-cloudwatch-y-prefect-12)
6. [Capa 5 — Frontend (8%)](#6-capa-5--frontend-8)
7. [Banco oficial de preguntas (sección 6) — respuestas completas](#7-banco-oficial-de-preguntas-sección-6--respuestas-completas)
8. [Otras preguntas probables, por capa](#8-otras-preguntas-probables-por-capa)
9. [Demostraciones en caliente: chuleta de comandos](#9-demostraciones-en-caliente-chuleta-de-comandos)
10. [Resultado del ensayo completo (22-nov-2026)](#10-resultado-del-ensayo-completo-22-nov-2026)
11. [Diferencias con AWS real: qué decir](#11-diferencias-con-aws-real-qué-decir)
12. [Trampas que cuestan puntos](#12-trampas-que-cuestan-puntos)

---

## 1. El proyecto en dos minutos

**El negocio.** AegisVolt administra electrolineras para flotas eléctricas. La operación crítica es **«Reservar y activar carga»**: bloquear una bahía de carga, cobrar a la billetera de la flota y encender el cargador. Son tres servicios distintos con tres bases de datos distintas. Si el cargador falla, hay que **devolver el dinero y liberar la bahía**. Ese es el problema que resuelve el patrón **SAGA**.

**Los tres ambientes estáticos.** `dev`, `test` y `prod` existen al mismo tiempo y están completamente aislados. Cada uno tiene:

- su **workspace de Terraform** y su archivo de estado en S3;
- su **VPC** con subredes privadas y VPC Endpoints;
- sus **5 tablas DynamoDB**, incluida la de feature flags;
- su **clúster EKS**, sus **repositorios ECR** y su **API Gateway**;
- su **rama de Git**: un merge a esa rama es lo único que lo despliega.

**Arquitectura de un ambiente:**

```
 Navegador ──HTTP──► API Gateway HTTP API (aegisvolt-<env>)
                        │  GET / y GET /{proxy+} ─► UI (nginx)
                        │  ANY /graphql            ─► graphql-gateway
                        ▼
                     VPC Link ──► NLB interno ──► NodePort 30080/30081 ──► pods (EKS, subredes privadas)
                                                                             │
   Prefect (auditoría) ──► API REST PRIVATE (solo desde el VPCE execute-api) ┘
                                                                             │
     graphql-gateway (orquestador SAGA) ──HTTP + x-correlation-id──► station-reservation-service
                                                                 ──► billing-wallet-service
                                                                 ──► energy-dispatch-service
     Cada servicio ──► su tabla DynamoDB (Gateway VPCE)   ──► CloudWatch Logs (Interface VPCE)
```

**Stack.** TypeScript y Fastify en los microservicios; GraphQL con graphql-yoga; DynamoDB; Terraform ~> 6 con el provider AWS; Kubernetes con kustomize; Prefect 3.1.15; React + Vite servido por nginx; GitHub Actions con un runner self-hosted. Todo AWS se emula con **Floci** en `http://localhost:4566`; el enunciado lo permite («con o sin Floci»).

**Estado al cierre:** PR #1 a #15 fusionados, y `dev`, `test` y `prod` con el mismo contenido. El PR #16 tiene las correcciones del ensayo (sección 10).

---

## 2. Capa 1 — IaC, S3, redes y DynamoDB (30%)

### 2.1 Backend de Terraform en S3 con versiones

| | |
|---|---|
| **Objetivo del enunciado** | El estado de Terraform debe vivir en S3, con versionamiento e historial, para poder recuperarse de un cambio corrupto. |
| **Qué se hizo** | Un módulo aparte, `infra/bootstrap`, crea el bucket `aegisvolt-tfstate` con **versioning habilitado**, cifrado y bloqueo de acceso público. El estado del propio bootstrap también migra al bucket. |
| **Cómo se cumple** | Cada `apply` deja una versión nueva del archivo. El workspace `dev` tiene hoy 9 versiones. El script de restauración descarga una versión, valida el `lineage` y la sube con `terraform state push`; probado en el ensayo. |
| **Código** | Bucket y versioning: [bootstrap/main.tf:35](../infra/bootstrap/main.tf#L35). Backend: [versions.tf:28-33](../infra/terraform/versions.tf#L28). Restauración: [restore-state.ps1](../scripts/infra/restore-state.ps1). Arranque: [bootstrap.ps1](../scripts/infra/bootstrap.ps1). |

**Por qué un módulo aparte.** Es el problema del huevo y la gallina: el bucket del estado no puede guardar el estado de su propia creación antes de existir. El bootstrap aplica primero con backend local y después ejecuta `init -migrate-state` hacia el bucket recién creado.

**Bloqueo.** `use_lockfile = true` usa el bloqueo nativo de S3: un archivo `.tflock` junto al estado ([versions.tf:33](../infra/terraform/versions.tf#L33)). Dos `apply` simultáneos sobre el mismo ambiente no pueden correr. El CD además tiene `concurrency` por rama ([cd.yml:21](../.github/workflows/cd.yml#L21)).

### 2.2 Workspaces dev / test / prod

| | |
|---|---|
| **Objetivo** | Uso real de workspaces: un solo código, tres ambientes, sin que uno pise al otro. |
| **Qué se hizo** | Un único root module en `infra/terraform`. El ambiente **sale del workspace**, no de una variable: `environment = terraform.workspace`. Cada ambiente tiene su `tfvars` en `environments/`. |
| **Cómo se cumple** | Hay cuatro barreras independientes (tabla abajo). En el ensayo, `plan` con `prod.tfvars` en el workspace `test` falló con «El tfvars es de 'prod' pero el workspace activo es 'test'»; en `default` falló con «Workspace 'default' invalido». |
| **Código** | [locals.tf:9](../infra/terraform/locals.tf#L9) (ambiente), [locals.tf:54](../infra/terraform/locals.tf#L54) (guardas), [versions.tf:31](../infra/terraform/versions.tf#L31) (`workspace_key_prefix`), [terraform.ps1:29](../scripts/ci/terraform.ps1#L29) (`workspace select`). |

| Barrera | Qué impide |
|---------|-----------|
| `workspace_key_prefix = "env:"` | Que `test` lea o escriba el tfstate de `prod`: cada workspace tiene su key, `env:/<ws>/aegisvolt/terraform.tfstate`. |
| Nombres con el workspace | Que dos ambientes generen el mismo nombre de recurso: `aegisvolt-billing-test` ≠ `aegisvolt-billing-prod`. |
| `precondition` (guardas) | Aplicar el `tfvars` de otro ambiente o usar el workspace `default`. |
| El pipeline elige el workspace | Que alguien aplique a mano sobre el ambiente equivocado: el CD solo aplica el ambiente de la rama que recibió el merge. |

### 2.3 Red privada: VPC, subredes y VPC Endpoints

| | |
|---|---|
| **Objetivo** | Arquitectura de red privada: VPC y VPCE hacia API Gateway y Kubernetes, sin que el tráfico salga a Internet. |
| **Qué se hizo** | Una VPC por ambiente con subredes públicas y privadas. La tabla de rutas privada (`rt-private`) **solo tiene la ruta local**: no hay NAT ni `0.0.0.0/0`. Hay **Gateway VPCE** de S3 y DynamoDB, e **Interface VPCE** de `execute-api`, `logs`, `monitoring`, `sts`, `ecr.api`, `ecr.dkr` y `eks`. |
| **Cómo se cumple** | En el ensayo, `describe-route-tables` de `aegisvolt-dev-rt-private` mostró solo `10.10.0.0/16 → local`. Se listaron los 9 endpoints. La policy del VPCE de DynamoDB solo permite tablas `aegisvolt-*-dev`. |
| **Código** | [network/main.tf](../infra/terraform/modules/network/main.tf): `rt-private` en la línea 83, Gateway VPCE en 99 (DynamoDB) y 129 (S3), policy por ambiente en 109, SG de los endpoints en 156, Interface VPCE en 172. |

**Gateway vs Interface.** S3 y DynamoDB son los únicos servicios con endpoint tipo **Gateway**: funcionan con una entrada en la tabla de rutas (prefix list), sin ENI y sin costo por hora. El resto solo existe como **Interface** (PrivateLink): una ENI con IP privada en la subred y DNS privado.

### 2.4 API Gateway → VPC Link → NLB → Kubernetes

| | |
|---|---|
| **Objetivo** | Que el API Gateway llegue a los pods de EKS sin exponerlos. |
| **Qué se hizo** | Hay dos entradas. (1) Una **HTTP API pública** con **VPC Link** hacia un **NLB interno**, que reenvía al NodePort 30080 (GraphQL) y 30081 (UI). (2) Una **REST API `PRIVATE`** con resource policy `aws:SourceVpce`: solo responde a llamadas que lleguen por el VPCE `execute-api` del ambiente. La usa Prefect. |
| **Cómo se cumple** | `get-rest-api` muestra `PRIVATE`, el VPCE asociado y la policy con `Allow` si `aws:SourceVpce` coincide y `Deny` si no. Los targets del NLB están `healthy`. |
| **Código** | [api-gateway/main.tf](../infra/terraform/modules/api-gateway/main.tf): SG del VPC Link en 30, NLB en 101, target group en 110, VPC Link en 146, HTTP API en 153, API privada en 223 y policy en 248. Rutas de la UI: [frontend.tf](../infra/terraform/modules/api-gateway/frontend.tf). |

**Cadena de security groups:** `sg-vpclink` → `sg-nlb` → `sg-nodes`. Cada uno solo acepta tráfico del anterior en el puerto exacto. Los nodos no aceptan nada desde Internet.

### 2.5 DynamoDB: Database-per-Service

| | |
|---|---|
| **Objetivo** | Aprovisionar las tablas de cada servicio y ambiente con Terraform. |
| **Qué se hizo** | 5 tablas por ambiente, 15 en total: `reservations`, `billing`, `dispatch`, `saga` y `feature-flags`, todas con el sufijo `-<env>`. Cada servicio es **dueño de su tabla** y su rol IAM solo puede escribir en ella. |
| **Cómo se cumple** | `aws dynamodb list-tables` muestra las 15 tablas. |
| **Código** | Catálogo de tablas: [locals.tf:21](../infra/terraform/locals.tf#L21). Módulo: [dynamodb/main.tf:9](../infra/terraform/modules/dynamodb/main.tf#L9). Roles por servicio con Pod Identity: [eks/main.tf:278](../infra/terraform/modules/eks/main.tf#L278). |

### 2.6 EKS y ECR

- **EKS:** un clúster por ambiente ([eks/main.tf:171](../infra/terraform/modules/eks/main.tf#L171)) con node group en subredes privadas ([línea 199](../infra/terraform/modules/eks/main.tf#L199)). Cada servicio tiene su rol IAM con **Pod Identity**. En Floci, cada clúster es un contenedor k3s real.
- **ECR:** un repositorio por servicio y ambiente, **IMMUTABLE** ([ecr/main.tf](../infra/terraform/modules/ecr/main.tf)). Un tag nunca se sobrescribe: el tag es el hash del contenido del servicio.

---

## 3. Capa 2 — CI/CD, gobernanza de Git y canary (25%)

### 3.1 Protección de ramas

| | |
|---|---|
| **Objetivo** | Bloquear el force push y el push directo a las ramas de ambiente. |
| **Qué se hizo** | Un **ruleset** de GitHub, `protected-env-branches`, sobre `dev`, `test` y `prod`. Incluye `deletion`, `non_fast_forward`, `pull_request` (solo merge commit) y **6 checks obligatorios**. **Sin bypass**: ni el dueño del repositorio puede saltárselo. Está versionado como JSON y se aplica con un script. |
| **Cómo se cumple** | En el ensayo, el push directo a `test` respondió `GH013: Changes must be made through a pull request` y el force push con historia reescrita, `GH013: Cannot force-push to this branch`. |
| **Código** | [protected-env-branches.json](../.github/rulesets/protected-env-branches.json): bypass vacío en la línea 5, `non_fast_forward` en 14, solo `merge` en 23 y checks en 27. Se aplica con [setup-repo.ps1](../scripts/github/setup-repo.ps1). |

### 3.2 Promoción feature → dev → test → prod solo por PR

| | |
|---|---|
| **Objetivo** | Flujo de promoción por Merge Request, siempre en el mismo orden. |
| **Qué se hizo** | El job `promotion-guard` del CI es un check obligatorio. Solo acepta `feature/* → dev`, `dev → test` y `test → prod`; un PR `feature/x → prod` falla. También rechaza PR desde forks, porque el runner es self-hosted. |
| **Cómo se cumple** | Los 15 PR del proyecto siguieron ese camino; el historial de GitHub lo muestra. |
| **Código** | [ci.yml:46](../.github/workflows/ci.yml#L46) y [docs/GOBERNANZA-GIT.md](GOBERNANZA-GIT.md). |

### 3.3 CI: pruebas y `terraform plan` en el PR

| Job | Qué valida | Script |
|-----|-----------|--------|
| `promotion-guard` | Que la combinación origen → destino esté permitida | [ci.yml:46](../.github/workflows/ci.yml#L46) |
| `lint-build` | ESLint, tipos, build, esquema GraphQL, `terraform fmt`/`validate`, overlays kustomize y `docker build` | [lint-build.ps1](../scripts/ci/lint-build.ps1) |
| `unit-tests` | Lógica de negocio y motor SAGA, sin red; también pytest de las reglas de Prefect | [test.ps1](../scripts/ci/test.ps1) |
| `integration-tests` | Repositorios contra DynamoDB real de Floci, con tablas efímeras | [test.ps1](../scripts/ci/test.ps1) |
| `e2e-tests` | La SAGA completa por GraphQL con los 4 servicios levantados | [reserve-charge.e2e.test.ts](../tests/e2e/reserve-charge.e2e.test.ts) |
| `terraform-plan` | `plan` sobre el **workspace de la rama destino** (`github.base_ref`) | [ci.yml:108](../.github/workflows/ci.yml#L108) |

### 3.4 CD: `terraform apply` dinámico según la rama

| | |
|---|---|
| **Objetivo** | Tras el merge, aplicar Terraform **en el ambiente de la rama destino**, sin elegirlo a mano. |
| **Qué se hizo** | `cd.yml` se dispara con `push` a `dev`, `test` o `prod`; por el ruleset, eso solo ocurre con un merge. El job `resolve-env` lee **`github.ref_name`**, lo valida y lo publica como output. `terraform-apply` lo pasa al script, que hace `workspace select <env>` y `apply -auto-approve`. Después vienen `k8s-apply` y `canary-deploy`. |
| **Cómo se cumple** | El merge del PR #15 a `prod` disparó el CD de `prod` (run 43664008986), que aplicó en el workspace `prod`. |
| **Código** | [cd.yml](../.github/workflows/cd.yml): `resolve-env` en la línea 40, `terraform-apply` en 57, `canary-deploy` en 79. [terraform.ps1:29](../scripts/ci/terraform.ps1#L29) (`workspace select`) y [línea 58](../scripts/ci/terraform.ps1#L58) (`apply`). |

### 3.5 Canary en Kubernetes: 20% → 100%

| | |
|---|---|
| **Objetivo** | Estrategia canary: la versión nueva recibe el 20% del tráfico y solo pasa al 100% si es sana. |
| **Qué se hizo** | Cada servicio tiene dos Deployments: `stable` con 4 réplicas y `canary` con 0. Ambos llevan el label que selecciona el Service. Para desplegar, el canary sube a 1 réplica: 1 de 5 pods, o sea ~20% del tráfico. Un **gate** de 4 condiciones decide si promover o hacer rollback automático. |
| **Cómo se cumple** | Ensayo 22-nov: con 60% de errores inyectados, el canary dio 58% de error y la alarma pasó a `ALARM`: **ROLLBACK**. Sin errores: 23 de 100 requests al canary, 0% de error: **PROMOVIDO**. |
| **Código** | [canary-deploy.ps1](../scripts/ci/canary-deploy.ps1): umbrales en las líneas 22-23, lectura de CloudWatch en 126. Réplicas: [billing-wallet-service.yaml:45](../k8s/base/billing-wallet-service.yaml#L45) (stable) y [125](../k8s/base/billing-wallet-service.yaml#L125) (canary). Alarmas: [observability/main.tf:73](../infra/terraform/modules/observability/main.tf#L73). |

**Las 4 condiciones del gate** (todas obligatorias):

1. El pod canary está `Ready` y sin reinicios.
2. `RequestCount(Track=canary) ≥ 5`: el canary sí recibió tráfico real.
3. `ErrorCount / RequestCount ≤ 5%`, leído de **CloudWatch** (namespace `AegisVolt/<env>`, dimensión `Track=canary`).
4. La alarma `aegisvolt-<env>-<servicio>-canary-errors` no está en `ALARM`.

Si alguna falla, el canary vuelve a 0 réplicas, el stable queda intacto y el job termina en rojo.

---

## 4. Capa 3 — Backend, Kubernetes, GraphQL, SAGA y flags (25%)

### 4.1 Microservicios desacoplados

| Servicio | Responsabilidad | Tabla | Código |
|----------|----------------|-------|--------|
| `station-reservation-service` | Estaciones, conectores y bloqueo temporal de bahías | `aegisvolt-reservations-<env>` | [repository.ts](../services/station-reservation-service/src/repository.ts) |
| `billing-wallet-service` | Cotización, cobro y reembolso en la billetera de la flota | `aegisvolt-billing-<env>` | [repository.ts](../services/billing-wallet-service/src/repository.ts) |
| `energy-dispatch-service` | Activar el cargador, sesión de carga y telemetría | `aegisvolt-dispatch-<env>` | [app.ts](../services/energy-dispatch-service/src/app.ts) |
| `graphql-gateway` | API GraphQL unificada y **orquestador SAGA** | `aegisvolt-saga-<env>` | [src/](../graphql-gateway/src/) |
| `frontend` | UI web (nginx) | — | [frontend/](../frontend/) |

**Desacople:** cada servicio tiene su tabla, su rol IAM, su Deployment, su imagen y un contrato HTTP. La **NetworkPolicy** solo deja que el gateway llame a los servicios ([platform.yaml:43](../k8s/base/platform.yaml#L43)). Los servicios comparten solo la librería `@aegisvolt/common` (logger, flags, servidor), no datos.

**Kubernetes:** manifiestos en [k8s/base](../k8s/base/) y un overlay kustomize por ambiente ([k8s/overlays](../k8s/overlays/)). Pod Security `restricted`: sin root y con sistema de archivos de solo lectura.

### 4.2 Esquema GraphQL

Esquema unificado en [schema.graphql](../graphql-gateway/src/schema.graphql), con 11 queries y 4 mutations.

- **Queries:** `environment`, `featureFlags`, `stations`, `station`, `telemetry`, `chargingSessions`, `wallets`, `wallet`, `quote`, `transactions` y `transaction`.
- **Mutations:**
  - `reserveAndActivateCharge` dispara la SAGA.
  - `setFeatureFlag` cambia una flag en caliente.
  - `recoverTransaction` compensa una SAGA huérfana.
  - `topUpWallet` recarga saldo.

**Decisión de diseño:** `reserveAndActivateCharge` **nunca lanza error por un fallo de negocio**. Devuelve la transacción con `status: COMPENSATED` o `FAILED`, con los pasos y las compensaciones. El cliente siempre recibe el ticket completo de lo que pasó.

### 4.3 SAGA por orquestación

| | |
|---|---|
| **Objetivo** | Ejecución demostrable de transacciones compensatorias ante fallos inducidos. |
| **Qué se hizo** | Un motor SAGA genérico ([engine.ts](../graphql-gateway/src/saga/engine.ts)) y la SAGA concreta ([reserve-charge-saga.ts](../graphql-gateway/src/saga/reserve-charge-saga.ts)). El log de cada SAGA se persiste en DynamoDB **antes de cada transición**, con versión optimista. |
| **Cómo se cumple** | Ensayo 22-nov en `test`: SAGA `COMPENSATED`; en DynamoDB, `CHARGE` + `REFUND` de 1060 centavos, reserva `RELEASED` y saldo igual al inicial. |

**Pasos:**

| # | Paso | Servicio | Tipo | Compensación |
|---|------|----------|------|-------------|
| 0 | `PRICE_QUOTE` | billing | compensable (lectura) | — |
| 1 | `RESERVE_CONNECTOR` | station | compensable | liberar la bahía (`release`) |
| 2 | `CHARGE_WALLET` | billing | compensable | reembolsar (`refund`) |
| 3 | `ACTIVATE_CHARGER` | dispatch | **pivot** | — (punto de no retorno) |
| 4 | `CONFIRM_RESERVATION` | station | retriable | se reintenta, no se compensa |

- **Orden inverso:** si falla el paso 3, se compensa el 2 y después el 1 (reembolso → liberación). El recorrido es `for (let i = steps.length - 1; i >= 0; i--)` en [engine.ts:176](../graphql-gateway/src/saga/engine.ts#L176).
- **Fondos insuficientes:** falla el paso 2; solo se libera la bahía.
- **Fallo ambiguo** (timeout, red, 5xx): también se compensa el paso que falló, porque el servicio pudo aplicar el efecto aunque se perdiera la respuesta ([engine.ts:122](../graphql-gateway/src/saga/engine.ts#L122)).
- **Recuperación:** `recover()` compensa una SAGA que quedó a medias porque el pod murió ([engine.ts:232](../graphql-gateway/src/saga/engine.ts#L232)). La invoca Prefect.

### 4.4 Feature flags por ambiente

| | |
|---|---|
| **Objetivo** | Aislar el estado de las flags en cada ambiente estático. |
| **Qué se hizo** | Una tabla por ambiente, `aegisvolt-feature-flags-<env>`, con las tres flags del enunciado. Terraform siembra el valor inicial desde el `tfvars` y después **ignora cambios** (`ignore_changes`), así un `apply` no pisa lo que se cambió en caliente. Cada pod lee la flag con **cache de 3 s**. |
| **Cómo se cumple** | Ensayo: `dev` y `test` tienen tarifa dinámica y ultra-carga en ON; `prod` tiene todo en OFF y **rechaza** `setFeatureFlag` («La administracion de flags esta deshabilitada en prod»). |
| **Código** | [feature-flags/main.tf:42](../infra/terraform/modules/feature-flags/main.tf#L42) (`ignore_changes`), [flags.ts:38](../packages/common/src/flags.ts#L38) (cache de 3 s), [resolvers.ts:153](../graphql-gateway/src/resolvers.ts#L153) (mutation), [overlays/prod/kustomization.yaml:25](../k8s/overlays/prod/kustomization.yaml#L25) (`FLAG_ADMIN_ENABLED=false`). |

| Flag | Efecto |
|------|--------|
| `ENABLE_DYNAMIC_SURGE_PRICING` | Tarifa ×1.5 en hora pico (7-10 h y 17-21 h, hora de Bogotá) |
| `ENABLE_FAST_CHARGE_BOOST` | Permite reservas prioritarias en conectores ULTRA de 350 kW |
| `SIMULATE_CHARGER_HARDWARE_FAULT` | `energy-dispatch-service` responde `422 CHARGER_HARDWARE_FAULT`: es la falla que dispara la compensación ([app.ts:47](../services/energy-dispatch-service/src/app.ts#L47)) |

---

## 5. Capa 4 — Observabilidad: CloudWatch y Prefect (12%)

### 5.1 Logs en CloudWatch con `correlation_id`

| | |
|---|---|
| **Objetivo** | Trazabilidad de los logs en CloudWatch por ambiente y por `correlation_id`. |
| **Qué se hizo** | Los logs son JSON estructurado y van a log groups `/aegisvolt/<env>/<servicio>`. El `correlation_id` **es el `sagaId`**. El gateway lo envía en el header `x-correlation-id` y cada servicio crea un logger hijo que lo incluye en cada línea. |
| **Cómo se cumple** | Ensayo: `trace-saga.ps1` reconstruyó la SAGA fallida con **24 eventos de los 4 servicios**: `saga_started` → `wallet_charged` → `charger_fault` → `wallet_refund` → `reservation_released` → `saga_compensated`. |
| **Código** | Header: [server.ts:42](../packages/common/src/server.ts#L42) (entrada) y [http-client.ts:43](../packages/common/src/http-client.ts#L43) (salida). Logger: [logger.ts](../packages/common/src/logger.ts). Log groups: [observability/main.tf:43](../infra/terraform/modules/observability/main.tf#L43). Consulta: [trace-saga.ps1](../scripts/demo/trace-saga.ps1). |

**Métricas:** los metric filters ([observability/main.tf:57](../infra/terraform/modules/observability/main.tf#L57)) convierten los logs en `RequestCount`, `ErrorCount`, `SagaCompensated` y `SagaFailed`, con las dimensiones `Service` y `Track`. Las mismas métricas alimentan el gate del canary.

### 5.2 Prefect

| | |
|---|---|
| **Objetivo** | Flujos funcionales en Prefect que supervisen el estado de la arquitectura y las transacciones SAGA. |
| **Qué se hizo** | Prefect 3.1.15 en Docker Compose: un servidor más un *observer* que sirve los deployments. Hay tres. |
| **Cómo se cumple** | Ensayo: el run `on-demand` terminó `COMPLETED`, con los 3 ambientes **SANO** y 4 artifacts. Se creó una SAGA huérfana y la auditoría la compensó: «recuperada via API private -> COMPENSATED». |
| **Código** | [health.py:117](../prefect/aegisvolt_observability/health.py#L117), [saga_audit.py:116](../prefect/aegisvolt_observability/saga_audit.py#L116), [audit_rules.py](../prefect/aegisvolt_observability/audit_rules.py), [serve.py:13-15](../prefect/aegisvolt_observability/serve.py#L13). |

| Deployment | Frecuencia | Qué hace |
|-----------|-----------|----------|
| `environment-health/every-2-minutes` | 120 s | Por ambiente: API Gateway responde, clúster `ACTIVE`, targets del NLB `healthy`, alarmas y flags. |
| `saga-consistency-audit/every-5-minutes` | 300 s | Cruza el log de cada SAGA con las tablas de los 3 servicios. La clasifica (`OK`, `COMPENSATED_OK`, `IN_FLIGHT`, `ORPHANED`, `NEEDS_ATTENTION` o `INCONSISTENT`), compensa las huérfanas por la **API privada** y publica métricas. |
| `aegisvolt-observability/on-demand` | manual | Ejecuta los dos anteriores; es el que se usa en la demo. |

**Huérfana** = estado no terminal y más de 120 s sin avanzar ([saga_audit.py:119](../prefect/aegisvolt_observability/saga_audit.py#L119), [audit_rules.py:89](../prefect/aegisvolt_observability/audit_rules.py#L89)). **Inconsistente** = estado terminal que no cuadra con las tablas; por ejemplo, `COMPENSATED` con un cobro y sin su reembolso.

---

## 6. Capa 5 — Frontend (8%)

| | |
|---|---|
| **Objetivo** | Interfaz conectada al GraphQL de cada ambiente, que refleje en tiempo real las flags y el estado de reservas y compensaciones. |
| **Qué se hizo** | React + Vite + TypeScript con la metáfora «surtidor y ticket térmico». La misma imagen sirve los 3 ambientes y averigua en cuál está consultando `environment` por GraphQL. Se sirve **detrás del mismo API Gateway**, así que `/graphql` es del mismo origen. |
| **Cómo se cumple** | Ensayo en Chrome: al apagar `ENABLE_FAST_CHARGE_BOOST` en dev, el interruptor de ultra-carga pasó a «Apagada en este ambiente» sin recargar la página. El ticket de una SAGA compensada sale en negativo con el sello REVERSO. |
| **Código** | [App.tsx](../frontend/src/App.tsx), polling en [graphql.ts:46](../frontend/src/lib/graphql.ts#L46), panel de flags en [ServiceCabinet.tsx](../frontend/src/components/ServiceCabinet.tsx), runtime config en [config.ts](../frontend/src/lib/config.ts). |

**Qué muestra:**

1. Panel de electrolineras y conectores en vivo, con polling cada 2-3 s.
2. Flujo de reserva y activación que llama a `reserveAndActivateCharge`.
3. Panel de flags con cambio en caliente, más un tablero con la misma flag en dev, test y prod.
4. Historial de transacciones como tickets, con pasos y compensaciones.

**Tiempo real:** se hace con **polling**, no con WebSocket; la defensa está en la sección 8.5.

---

## 7. Banco oficial de preguntas (sección 6) — respuestas completas

### 6.1-a ¿Cómo garantiza que un `terraform apply` en `test` no sobrescriba las tablas DynamoDB ni el estado de `prod` en S3?

**Respuesta corta:** «Porque el ambiente sale del workspace: cada workspace tiene su propia key de estado en S3, todos los nombres llevan el workspace, y hay guardas que rechazan un tfvars de otro ambiente.»

**Explicación:**
- **Estado:** con `workspace_key_prefix = "env:"`, el estado de `test` vive en `env:/test/aegisvolt/terraform.tfstate` y el de `prod` en `env:/prod/...`. Desde `test`, Terraform ni siquiera abre el archivo de `prod` ([versions.tf:31](../infra/terraform/versions.tf#L31)).
- **Tablas:** los nombres se arman como `aegisvolt-<servicio>-${terraform.workspace}`. Desde `test` solo se gestionan las tablas `-test`; las de `prod` no están en ese estado, así que no se pueden modificar ni destruir ([locals.tf:9](../infra/terraform/locals.tf#L9), [locals.tf:21](../infra/terraform/locals.tf#L21)).
- **Error humano:** si alguien selecciona `test` y pasa `prod.tfvars`, la `precondition` aborta el plan ([locals.tf:54](../infra/terraform/locals.tf#L54)).
- **Pipeline:** el CD solo aplica el workspace de la rama que recibió el merge ([cd.yml:40](../.github/workflows/cd.yml#L40)).

**Demostración:**
```powershell
cd infra\terraform
terraform workspace select test
terraform plan "-var-file=environments/prod.tfvars"   # Error: El tfvars es de 'prod' pero el workspace activo es 'test'.
terraform workspace select dev; cd ..\..
aws s3 ls --recursive s3://aegisvolt-tfstate/ | Select-String -NotMatch tflock
```

### 6.1-b Muestre las versiones anteriores del tfstate de `dev` y cómo restauraría la versión previa

**Respuesta corta:** «El bucket tiene versioning; cada apply crea una versión. Restaurar es descargar la versión buena, validar que tenga el mismo lineage y subirla con `terraform state push`. La versión mala no se borra: queda en el historial.»

**Explicación:**
- Versioning: [bootstrap/main.tf:35](../infra/bootstrap/main.tf#L35).
- El script hace cuatro cosas:
  1. Lista las versiones con `list-object-versions`.
  2. Descarga la elegida con `get-object --version-id`.
  3. Compara su `lineage` con el estado actual ([restore-state.ps1:46](../scripts/infra/restore-state.ps1#L46)); si no coincide, no es el mismo estado y aborta.
  4. Hace `terraform state push -force`. El `-force` hace falta porque el serial restaurado es menor que el actual.
- Después, `terraform plan` dice qué diferencia hay entre esa versión del estado y la infraestructura real.

**Demostración:**
```powershell
.\scripts\infra\restore-state.ps1 -Environment dev                                  # tabla VersionId / fecha / IsLatest
.\scripts\infra\restore-state.ps1 -Environment dev -VersionId <VersionId IsLatest>  # inocuo: restaura la actual
cd infra\terraform; terraform plan "-var-file=environments/dev.tfvars"; cd ..\..   # No changes
```
Equivalente directo con la CLI:
```powershell
aws s3api list-object-versions --bucket aegisvolt-tfstate --prefix env:/dev/aegisvolt/terraform.tfstate --query "Versions[?Key=='env:/dev/aegisvolt/terraform.tfstate'].[VersionId,LastModified,IsLatest,Size]" --output table
```
**La consola de Floci no lista versiones de objetos.** En la UI (Storage → `aegisvolt-tfstate` → `env:` → `dev` → `aegisvolt` → `terraform.tfstate`) solo se ven la key por workspace y su «Last Modified», que cambia con cada `apply`. Si el profesor pregunta: «La consola del emulador no muestra el historial; el versioning está en la API de S3, que es la que usa Terraform y la que uso para restaurar.»

### 6.1-c Recorrido de un paquete desde API Gateway hasta el pod a través del VPCE; qué tabla de rutas o política interviene

**Respuesta corta:** «Un cliente de la VPC resuelve `execute-api` por DNS privado a la ENI del Interface VPCE; el security group del VPCE solo acepta 443 desde la VPC; la resource policy de la API privada solo permite ese `aws:SourceVpce`; API Gateway entrega por el VPC Link al NLB interno, que llega al NodePort del nodo y kube-proxy al pod. La tabla `rt-private` solo tiene la ruta local, así que nada sale a Internet.»

**Paso a paso:**

| # | Salto | Qué interviene | Código |
|---|-------|---------------|--------|
| 1 | Cliente en la VPC → `https://<api>.execute-api...` | DNS privado del Interface VPCE (`private_dns_enabled`) | [network/main.tf:172](../infra/terraform/modules/network/main.tf#L172) |
| 2 | → ENI del VPCE, en una subred privada | `sg-vpce`: 443 solo desde el CIDR de la VPC | [network/main.tf:156](../infra/terraform/modules/network/main.tf#L156) |
| 3 | VPCE → API REST `PRIVATE` | **Resource policy**: `Allow` si `aws:SourceVpce` = el VPCE del ambiente, `Deny` si no | [api-gateway/main.tf:223](../infra/terraform/modules/api-gateway/main.tf#L223), [248](../infra/terraform/modules/api-gateway/main.tf#L248) |
| 4 | API Gateway → VPC Link | `sg-vpclink` | [api-gateway/main.tf:146](../infra/terraform/modules/api-gateway/main.tf#L146) |
| 5 | VPC Link → NLB interno | `sg-nlb`; listener → target group | [api-gateway/main.tf:101](../infra/terraform/modules/api-gateway/main.tf#L101) |
| 6 | NLB → NodePort 30080 del nodo | `sg-nodes`; **`rt-private` solo con `local`** | [network/main.tf:83](../infra/terraform/modules/network/main.tf#L83) |
| 7 | kube-proxy → pod `graphql-gateway` | Service NodePort; NetworkPolicy | [k8s/base/graphql-gateway.yaml](../k8s/base/graphql-gateway.yaml) |

**De vuelta, el pod a DynamoDB:** la tabla `rt-private` tiene la ruta prefix-list del **Gateway VPCE**, cuya policy solo permite tablas `aegisvolt-*-<env>` ([network/main.tf:99-129](../infra/terraform/modules/network/main.tf#L99)).

**Demostración:** los comandos del bloque 2.3 de [GUION-DEMO.md](GUION-DEMO.md#23-recorrido-del-paquete-por-vpc-endpoints) muestran el VPCE, la policy, la tabla de rutas, los 9 endpoints y los targets del NLB.

### 6.2-a Intente un `git push --force` o un push directo a `test` y muestre qué regla lo bloquea

**Respuesta corta:** «El ruleset `protected-env-branches`: la regla `pull_request` bloquea el push directo y `non_fast_forward` el force push; no hay bypass para nadie, ni para el dueño. GitHub responde GH013.»

**Demostración (probada el 22-nov):**
```powershell
git switch test; git pull -q
git commit --allow-empty -m "intento directo"
git push origin test             # GH013: Changes must be made through a pull request
git reset --hard HEAD~1; git commit --allow-empty -m "historia reescrita"
git push --force origin test     # GH013: Cannot force-push to this branch
git reset --hard origin/test; git switch dev
```
**Ojo:** un `--force` de un commit que solo avanza la rama no es non-fast-forward; GitHub solo muestra la regla de PR. Para ver «Cannot force-push» hay que reescribir la historia, como arriba.

Además, la pestaña Settings → Rules → Rulesets muestra el ruleset con bypass vacío. El JSON versionado es [protected-env-branches.json](../.github/rulesets/protected-env-branches.json).

### 6.2-b Explique en el YAML cómo se determina dinámicamente sobre qué ambiente correr `terraform apply` tras un merge

**Respuesta corta:** «El CD se dispara con push a dev, test o prod, y eso solo pasa por un merge. El job `resolve-env` lee `github.ref_name`, que es la rama que recibió el merge, y ese valor llega al script que hace `terraform workspace select` y `apply -auto-approve`.»

**Explicación:**
- `on.push.branches: [dev, test, prod]` en [cd.yml](../.github/workflows/cd.yml).
- `resolve-env` ([línea 40](../.github/workflows/cd.yml#L40)) valida que `github.ref_name` sea uno de los tres ambientes y lo expone como `outputs.environment`.
- `terraform-apply` ([línea 57](../.github/workflows/cd.yml#L57)) ejecuta `terraform.ps1 -Action apply -Environment <output>`. El script hace `workspace select` ([terraform.ps1:29](../scripts/ci/terraform.ps1#L29)), comprueba que el workspace activo sea el pedido y aplica ([línea 58](../scripts/ci/terraform.ps1#L58)).
- **No confundir con el CI:** en el PR el ambiente es `github.base_ref`, la rama destino, y solo se hace `plan`.

### 6.2-c ¿Qué métrica o condición evalúa el canary antes de pasar del 20% al 100%?

**Respuesta corta:** «La tasa de error del canary en CloudWatch: `ErrorCount / RequestCount` con dimensión `Track=canary` debe ser ≤ 5%, con al menos 5 requests, el pod Ready sin reinicios y la alarma `canary-errors` fuera de ALARM. Si algo falla, rollback automático.»

**Explicación:** ver la sección 3.5. Las métricas salen de **metric filters sobre los logs JSON**. Cada log de request lleva `track: canary|stable` porque cada pod conoce su track por variable de entorno. Los umbrales son parámetros del script ([canary-deploy.ps1:22-23](../scripts/ci/canary-deploy.ps1#L22)).

**Demostración:**
```powershell
.\scripts\ci\canary-deploy.ps1 -Environment dev -Service billing-wallet-service -Version demo -Force -InjectErrorRate 0.6 -Requests 100   # ROLLBACK
# esperar a que la alarma vuelva a OK (~3 min) antes de repetir
.\scripts\ci\canary-deploy.ps1 -Environment dev -Service billing-wallet-service -Version demo-ok -Force -Requests 100                     # PROMOVIDO
```

### 6.3-a Active la flag de fallo en `test`, dispare la mutación y demuestre en DynamoDB la compensación en facturación y reservas

**Respuesta corta:** «Con la flag activa, energy-dispatch responde que el cargador falló; el orquestador compensa en orden inverso: primero reembolsa en billing y después libera la bahía en station. En DynamoDB se ven el CHARGE y el REFUND con el mismo sagaId y la reserva en RELEASED.»

**Pasos (probados el 22-nov):**
1. En la UI de **test**, panel de servicio: **Simular falla de hardware** en ON. La lámpara de TEST se enciende y PROD sigue en off.
2. **Espera 4 segundos**: los pods tienen la flag en cache 3 s.
3. Autoriza una carga de 20 kWh para *Logística Andina Express*. El ticket sale en negativo, con el sello **REVERSO**.
4. Copia el `correlation_id` del pie del ticket y consulta DynamoDB:

```powershell
$SAGA = "<sagaId>"
aws dynamodb query --table-name aegisvolt-billing-test --key-condition-expression "pk = :p AND begins_with(sk, :t)" `
  --expression-attribute-values "{\":p\":{\"S\":\"WALLET#fleet-andina\"},\":t\":{\"S\":\"TXN#$SAGA\"}}" `
  --query "Items[].{sk:sk.S,tipo:type.S,monto:amountCents.N}" --output table              # CHARGE + REFUND
aws dynamodb get-item --table-name aegisvolt-reservations-test `
  --key "{\"pk\":{\"S\":\"RESERVATION#$SAGA\"},\"sk\":{\"S\":\"META\"}}" --query "Item.{estado:status.S}"   # RELEASED
aws dynamodb get-item --table-name aegisvolt-saga-test `
  --key "{\"pk\":{\"S\":\"SAGA#$SAGA\"},\"sk\":{\"S\":\"META\"}}" --query "Item.status.S"                     # COMPENSATED
```
5. Apaga la flag.

**Resultado del ensayo:** `saga-f30cbe33…` en `COMPENSATED`; `TXN#…#CHARGE` y `TXN#…#REFUND` de 1060; reserva `RELEASED`; saldo 50000 antes y después.

**Por qué ese orden:** es el inverso al de ejecución, así nunca queda la bahía libre mientras el dinero sigue retenido.

### 6.3-b ¿Cómo evita problemas de idempotencia si una compensación se procesa dos veces?

**Respuesta corta:** «El sagaId es la clave de idempotencia: el reembolso inserta un registro `TXN#<sagaId>#REFUND` con `attribute_not_exists` dentro de la misma transacción de DynamoDB que suma el saldo. Si llega dos veces, la condición falla, la transacción entera se cancela y devuelve `ALREADY_REFUNDED` sin tocar el saldo.»

**Explicación:**
- **Reembolso:** `TransactWriteItems` con dos operaciones atómicas: el `Put` condicional del registro de reembolso y el `Update` del saldo. O pasan las dos o ninguna ([billing repository.ts:159](../services/billing-wallet-service/src/repository.ts#L159)).
- **Liberación:** solo libera si `reservedBy = <sagaId>`. Repetida, devuelve `ALREADY_RELEASED` ([station repository.ts:179](../services/station-reservation-service/src/repository.ts#L179)).
- **Cobro:** misma técnica, con `attribute_not_exists(pk)` ([billing repository.ts:135](../services/billing-wallet-service/src/repository.ts#L135)).
- **La SAGA completa:** el registro se crea con `attribute_not_exists`. Repetir la mutation con la misma `idempotencyKey` devuelve la SAGA existente sin ejecutarla de nuevo ([store.ts:33](../graphql-gateway/src/saga/store.ts#L33), [engine.ts:86](../graphql-gateway/src/saga/engine.ts#L86)).
- **Concurrencia en el log:** cada guardado exige `#v = :expected`, una versión optimista ([store.ts:50](../graphql-gateway/src/saga/store.ts#L50)).

**Demostración (probada):**
```powershell
kubectl --kubeconfig "$HOME\.kube\aegisvolt-test.yaml" -n aegisvolt exec deploy/graphql-gateway -- node -e "fetch('http://billing-wallet-service:8080/charges/$SAGA/refund',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fleetId:'fleet-andina'})}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))"
# {"outcome":"ALREADY_REFUNDED","alreadyRefunded":true,...}  -> el saldo no cambia
```

### 6.4-a Muestre en Prefect el flujo de observabilidad y rastree en CloudWatch el `correlation_id` de una SAGA fallida

**Respuesta corta:** «El sagaId es el correlation_id; el gateway lo propaga en el header `x-correlation-id` y cada servicio lo escribe en cada log. Una consulta de Logs Insights sobre los 4 log groups del ambiente reconstruye la SAGA de punta a punta.»

```powershell
docker exec aegisvolt-prefect-prefect-observer-1 prefect deployment run "aegisvolt-observability/on-demand"
.\scripts\demo\trace-saga.ps1 -Environment test -SagaId $SAGA
```
En Prefect (http://localhost:4200) abre el run. Muestra los subflows `environment-health` y `saga-consistency-audit`, y los artifacts: tabla de salud, matriz de flags por ambiente y auditoría de SAGAs.

### 6.4-b Cambie una flag en `dev` sin redesplegar y muestre que el frontend de dev cambia y `prod` no

**Respuesta corta:** «La flag es un dato en la tabla `aegisvolt-feature-flags-dev`, no código ni configuración del pod; el pod la relee cada 3 s y la UI la consulta cada pocos segundos. Prod tiene su propia tabla, así que no se entera.»

**Pasos (probados el 22-nov):**
1. UI de dev y UI de prod lado a lado.
2. En dev, **Ultra-carga prioritaria** en OFF. En 3-4 s, el interruptor de ultra-carga del teclado se bloquea («Apagada en este ambiente»). En prod no cambia nada.
3. Una reserva prioritaria en dev ahora sale `COMPENSATED` con `FEATURE_DISABLED`. Vuelve a encenderla: sale `COMPLETED` en C3 · ULTRA.
4. Prueba de que no hubo redespliegue: los mismos pods, con el mismo número de reinicios, y la misma imagen.
```powershell
kubectl --kubeconfig "$HOME\.kube\aegisvolt-dev.yaml" -n aegisvolt get pods -l app=graphql-gateway
```
5. En prod el panel dice «Panel bloqueado en producción» y la API responde «La administracion de flags esta deshabilitada en prod».

---

## 8. Otras preguntas probables, por capa

### 8.1 IaC y redes

**¿Para qué las subredes públicas si no hay nada en ellas?**
Las pide el enunciado. Tienen Internet Gateway y el tag `kubernetes.io/role/elb` para un balanceador público futuro. Ningún componente vive ahí y no hay NAT, así que las privadas no tienen salida. — [network/main.tf](../infra/terraform/modules/network/main.tf)

**¿Qué pasa si dos personas hacen `apply` a la vez?**
La segunda espera o falla por el lock nativo de S3 (`use_lockfile`, archivo `.tflock`). En el CD, `concurrency` por rama además encola los runs. — [versions.tf:33](../infra/terraform/versions.tf#L33), [cd.yml:21](../.github/workflows/cd.yml#L21)

**Quedó un lock colgado. ¿Cómo lo liberas?**
`terraform force-unlock <ID>`, con el ID que muestra el error. Solo cuando estás seguro de que ningún proceso sigue vivo. En el ensayo pasó al cortar un `plan` a mitad, y se liberó así.

**¿Por qué Terraform no registra los targets del NLB?**
Son las IPs de los nodos, que cambian. En AWS real los registra el AWS Load Balancer Controller con un `TargetGroupBinding`. Aquí lo hace el pipeline con la misma lógica: registra los nodos actuales y quita los que ya no existen. Terraform es dueño del NLB, el target group y el listener. — [k8s.ps1:102](../scripts/k8s/k8s.ps1#L102)

**¿Por qué el estado del bootstrap también está en S3?**
Para no depender de un archivo local que se pierda. Se aplica con backend local y luego `init -migrate-state`. — [bootstrap.ps1](../scripts/infra/bootstrap.ps1)

**¿Por qué el ECR es IMMUTABLE?**
Un tag nunca cambia de contenido, así que «qué corre en prod» es trazable al commit. El tag es un hash del contenido del servicio: el mismo código produce el mismo tag en los tres ambientes.

**¿El API server de EKS es público?**
Tiene acceso público y privado para que el runner llegue al clúster. Nodos y pods están en subredes privadas. En producción restringiría `public_access_cidrs` a la IP del runner o dejaría solo el endpoint privado.

### 8.2 CI/CD y canary

**¿Cómo se logra exactamente el 20%?**
El Service selecciona pods por un label que comparten stable y canary. Con 4 + 1 pods, kube-proxy reparte las conexiones y 1 de cada 5 va al canary. Es un reparto **estadístico por conexión**: en el ensayo salió 12% y 23%. Un 20% exacto por request exige un service mesh (Istio) o Argo Rollouts. El script mide el reparto real con el header `x-aegis-track`.

**¿Qué pasa si un servicio no cambió?**
Su tag (hash del contenido) es igual al del stable y el canary dice «sin cambios». No se despliega lo que no cambió.

**¿Por qué solo merge commit y no squash?**
Para que `dev`, `test` y `prod` compartan exactamente los mismos commits. Un squash crea commits nuevos en cada rama y las ramas divergen. — [protected-env-branches.json:23](../.github/rulesets/protected-env-branches.json#L23)

**¿El `apply` usa el mismo plan revisado en el PR?**
No exactamente. El plan del PR queda como artifact y en el resumen del job; el `apply` vuelve a planificar sobre el commit fusionado. Una mejora posible es guardar el `tfplan` y aplicar ese archivo.

**¿Por qué un runner self-hosted? ¿No es inseguro en un repo público?**
Floci vive en `localhost`, así que el pipeline tiene que correr en la misma máquina. `promotion-guard` rechaza los PR de forks antes de hacer checkout. Con AWS real usaría runners hospedados con OIDC.

**¿Dónde corren los tests E2E?**
Antes del merge, en el CI. Levantan los 4 servicios reales como procesos, contra DynamoDB de Floci con tablas efímeras, y ejercitan la SAGA completa por GraphQL. No usan el ambiente desplegado porque ese ambiente todavía no tiene el cambio.

### 8.3 Backend y SAGA

**¿Por qué orquestación y no coreografía?**
Un solo componente conoce la secuencia y guarda el log. El orden inverso de compensación es explícito y auditable, y Prefect puede leer un único log. El costo es que el gateway queda acoplado a los tres servicios.

**¿Qué es el pivot y por qué es `ACTIVATE_CHARGER`?**
Es el punto de no retorno: antes se puede deshacer todo, después solo hay pasos que se reintentan. Activar el cargador es físico: la energía entregada no se «des-entrega».

**¿Qué pasa si el orquestador muere a mitad de la SAGA?**
El log se guarda antes de cada transición. La SAGA queda en un estado no terminal; a los 120 s Prefect la marca huérfana y llama a `recoverTransaction`, que compensa lo hecho. Un paso que quedó `RUNNING` también se compensa, porque no se sabe si se aplicó. — [engine.ts:232](../graphql-gateway/src/saga/engine.ts#L232)

**¿Y si un paso hace timeout pero el servicio sí aplicó el cambio?**
El motor distingue el **rechazo definitivo** (4xx de dominio, por ejemplo fondos insuficientes) del **fallo ambiguo** (timeout, red, 5xx). En el ambiguo también compensa ese paso. Como la compensación es idempotente, si no había nada que deshacer responde `NOTHING_TO_REFUND` o `NOTHING_TO_RELEASE`. — [engine.ts:118-122](../graphql-gateway/src/saga/engine.ts#L118)

**¿Qué pasa si una compensación falla?**
Se reintenta hasta 4 veces con backoff exponencial. Si se agota, la SAGA queda `FAILED`, se emite `saga_failed` con nivel ERROR (cuenta en la métrica `SagaFailed`) y la auditoría la marca `NEEDS_ATTENTION`. — [engine.ts:170](../graphql-gateway/src/saga/engine.ts#L170)

**¿Cómo evitas que dos flotas reserven el mismo conector?**
Con una escritura condicional: el conector pasa a `RESERVED` solo si está `AVAILABLE` o si su bloqueo ya venció. Gana una; la otra recibe un error de dominio. — [station repository.ts:140](../services/station-reservation-service/src/repository.ts#L140)

**¿Una bahía puede quedar bloqueada para siempre?**
No. La reserva tiene `lockExpiresAt`: si nadie la confirma ni la libera, el bloqueo vence solo. Además, Prefect compensa las SAGAs huérfanas.

**¿Quién puede cambiar flags o llamar `recoverTransaction`?**
Hoy la API no tiene autenticación; el enunciado no la pedía. En prod `setFeatureFlag` está deshabilitado por configuración. En un sistema real pondría un authorizer JWT y dejaría las mutations administrativas solo en la API privada.

**¿Por qué cache de 3 s en las flags?**
Para no leer DynamoDB en cada request y aun así reflejar un cambio en segundos. Es un compromiso entre costo y latencia de propagación.

### 8.4 Observabilidad

**¿Cómo llegan los logs a CloudWatch?**
El logger hace `PutLogEvents` por lotes cada 2 s al log group `/aegisvolt/<env>/<servicio>`. Si CloudWatch falla, el servicio sigue funcionando y el log queda en stdout. La alternativa habitual en EKS es Fluent Bit como DaemonSet.

**¿Por qué Prefect corre fuera del clúster?**
Es el plano de observabilidad: si viviera dentro del clúster que vigila, caería con él. Además vigila los tres ambientes a la vez.

**¿Qué hace la auditoría con una SAGA inconsistente?**
No la toca: la reporta. Arreglarla automáticamente sin saber la causa puede empeorar el estado. Solo compensa automáticamente las huérfanas, que es un caso seguro.

### 8.5 Frontend

**¿Por qué polling y no WebSocket?**
El enunciado pide reflejar el estado en tiempo real, no un protocolo. Con polling de 2 a 5 s la UI usa la misma HTTP API y el mismo origen. Las subscriptions exigirían una WebSocket API aparte y conexiones persistentes a través del VPC Link. El polling se pausa con la pestaña oculta.

**¿Cómo sabe la UI en qué ambiente está si es la misma imagen?**
Pregunta `environment` por GraphQL a su propio origen. Las URLs de los otros ambientes, para el tablero comparativo, llegan por el ConfigMap `frontend-config`, que escribe el pipeline.

**¿Cómo consulta la UI de dev las flags de test y prod, que son otro origen?**
Con `GET /graphql?query=...`, una *simple request* de CORS que no dispara preflight. La API responde con `Access-Control-Allow-Origin: *`. Las mutations siempre van por POST al propio origen. — [graphql.ts:35](../frontend/src/lib/graphql.ts#L35)

**¿Cómo se despliega la UI?**
Igual que un microservicio: imagen nginx sin privilegios, Deployment stable + canary, NodePort 30081 detrás del mismo API Gateway (`GET /` y `GET /{proxy+}`). Su canary evalúa la tasa de 5xx en los access logs de nginx.

---

## 9. Demostraciones en caliente: chuleta de comandos

Pega esto una vez en la terminal de la demo:
```powershell
cd C:\Users\rogst\Downloads\Patrones\parcial3_patrones
$env:AWS_ENDPOINT_URL="http://localhost:4566"; $env:AWS_DEFAULT_REGION="us-east-1"
$env:AWS_ACCESS_KEY_ID="test"; $env:AWS_SECRET_ACCESS_KEY="test"
function Api($e) { "http://$(aws apigatewayv2 get-apis --query "Items[?Name=='aegisvolt-$e'].ApiId|[0]" --output text).execute-api.localhost.floci.io:4566" }
$DEV = Api dev; $TEST = Api test; $PROD = Api prod
function Gql($base, $q) { Invoke-RestMethod -Method Post -Uri "$base/graphql" -ContentType application/json -Body (@{query=$q}|ConvertTo-Json -Compress) | ConvertTo-Json -Depth 8 }
```

| Te piden… | Comando |
|-----------|---------|
| Inspeccionar el estado en S3 | `aws s3api list-object-versions --bucket aegisvolt-tfstate --prefix env:/dev/ --query "Versions[].[Key,VersionId,LastModified,IsLatest]" --output table` |
| Ver qué hay dentro del tfstate | `(aws s3 cp s3://aegisvolt-tfstate/env:/dev/aegisvolt/terraform.tfstate - \| ConvertFrom-Json) \| Select-Object serial, lineage, terraform_version, @{n='recursos';e={$_.resources.Count}}` |
| Recursos del estado de un ambiente | `cd infra\terraform; terraform workspace select test; terraform state list; terraform workspace select dev; cd ..\..` |
| Forzar un fallo en la SAGA (por API) | `Gql $TEST 'mutation { setFeatureFlag(name:"SIMULATE_CHARGER_HARDWARE_FAULT", enabled:true) { enabled } }'` y, tras 4 s: `Gql $TEST 'mutation { reserveAndActivateCharge(input:{fleetId:"fleet-andina", stationId:"st-bog-norte", kwh:20}) { sagaId status compensations { step outcome } } }'` |
| Forzar fondos insuficientes | `Gql $DEV 'mutation { reserveAndActivateCharge(input:{fleetId:"fleet-caribe", stationId:"st-bog-norte", kwh:60}) { sagaId status error { code } compensations { step outcome } } }'` (Caribe Delivery tiene saldo bajo) |
| Ver el historial de SAGAs | `Gql $DEV '{ transactions(limit: 5) { sagaId status compensations { step outcome } } }'` |
| Ver flags de los 3 ambientes | `foreach ($b in $DEV,$TEST,$PROD) { Gql $b '{ environment { environment } featureFlags { name enabled } }' }` |
| Ver pods y tracks | `kubectl --kubeconfig "$HOME\.kube\aegisvolt-dev.yaml" -n aegisvolt get pods -L aegisvolt.io/track` |
| Ver las alarmas | `aws cloudwatch describe-alarms --query "MetricAlarms[].[AlarmName,StateValue]" --output table` |
| Logs crudos de un servicio | `aws logs tail /aegisvolt/test/billing-wallet-service --since 10m` |
| Idempotencia de la SAGA completa | Repite dos veces la mutation con `idempotencyKey:"demo-1"`: devuelve el mismo `sagaId` |
| SAGA huérfana para Prefect | `.\scripts\demo\create-orphan-saga.ps1 -Environment dev` y luego `docker exec aegisvolt-prefect-prefect-observer-1 prefect deployment run "saga-consistency-audit/every-5-minutes"` |

> Flotas: `fleet-andina`, `fleet-caribe` (saldo bajo, 5 USD) y `fleet-pacifico`. Estaciones: `st-bog-norte`, `st-cdmx-vallejo` y `st-med-poblado`. Fondos insuficientes probado el 22-nov: `COMPENSATED`, `INSUFFICIENT_FUNDS`, solo `RESERVE_CONNECTOR → RELEASED`.

---

## 10. Resultado del ensayo completo (22-nov-2026)

Todo se ejecutó como en la sustentación: el guion completo, en orden, sobre los tres ambientes.

| Bloque | Prueba | Resultado |
|--------|--------|-----------|
| Arranque | `preflight.ps1 -Fix` | Floci estaba abajo: lo levantó, resincronizó los targets del NLB (los nodos k3s cambiaron de IP) y levantó Prefect. Segunda corrida: **todo OK**. El runner se arrancó a mano. |
| 6.1 | Guardas de workspace | `test` + `prod.tfvars` → error de precondition. `default` → error de precondition. |
| 6.1 | Versiones del tfstate | 9 versiones de `env:/dev`. Restauración de la versión actual → `plan`: **No changes**. |
| 6.1 | Red | `rt-private` solo `local`; 9 VPCE; policy `aws:SourceVpce`; policy de DynamoDB solo `aegisvolt-*-dev`; target `healthy`. |
| 6.2 | Push directo / force push | `GH013` en ambos («pull request» y «Cannot force-push»). |
| 6.2 | Canary con 60% de errores | 58% de error, alarma `ALARM` → **ROLLBACK**. |
| 6.2 | Canary sano | 23/100 al canary, 0% de error → **PROMOVIDO**. La alarma tardó ~3 min en volver a `OK`. |
| 6.3 | Falla en test | `COMPENSATED`: `REFUNDED` → `RELEASED`; CHARGE + REFUND en billing; reserva `RELEASED`; saldo intacto. |
| 6.3 | Idempotencia | Reembolso duplicado → `ALREADY_REFUNDED`, saldo sin cambio. Misma `idempotencyKey` → mismo `sagaId`. |
| 6.3 | prod protegido | `setFeatureFlag` en prod → rechazado. |
| 6.4 | Prefect | Run `on-demand` `COMPLETED`; 3 ambientes SANO; 4 artifacts; huérfana compensada «via API private». |
| 6.4 | CloudWatch | `trace-saga.ps1`: 24 eventos de los 4 servicios con el mismo `correlation_id`. |
| 6.4 | Flag en dev | La UI bloqueó la ultra-carga en caliente; prod sin cambio; mismos pods y misma imagen. |
| Pruebas | `npm run test:unit`, `test:integration`, `test:e2e` y `pytest prefect\tests` | **31 + 25 + 7 + 10 = 73 pruebas, todas en verde.** |

**Problemas encontrados y corregidos (PR #16):**
1. **Tablero de flags de otros ambientes en «SIN SEÑAL».** El POST con `content-type: application/json` dispara un preflight `OPTIONS` y el API Gateway de Floci responde 500. La lectura cruzada pasó a `GET`, que es una simple request y no lleva preflight. Verificado en Chrome.
2. **`restore-state.ps1` dejaba la terminal dentro de `infra\terraform`.** Ahora vuelve al directorio original.
3. **El guion del force push no mostraba «Cannot force-push».** Ahora reescribe la historia antes del `--force`.

> Hasta que el PR #16 llegue a cada ambiente, la UI de ese ambiente sigue mostrando «SIN SEÑAL» en el tablero comparativo. El resto de la UI funciona.

---

## 11. Diferencias con AWS real: qué decir

Dilo tú **antes** de que te lo pregunten, y muestra lo declarado en Terraform.

| Tema | Qué pasa en Floci | Frase |
|------|------------------|-------|
| Ruta prefix-list del Gateway VPCE | Floci guarda la asociación con `rt-private` pero no la muestra en `describe-route-tables` | «El Gateway VPCE está asociado a `rt-private` en Terraform; AWS inyecta la ruta `pl-xxxx → vpce-xxxx`; el emulador guarda la asociación pero no la materializa.» |
| Resource policy de la API privada | Floci no evalúa `aws:SourceVpce` | «La policy está declarada con Allow y Deny por `aws:SourceVpce`; el emulador no evalúa resource policies, así que aquí no puedo probar el rechazo desde fuera.» |
| Salida de los pods a AWS | Por un Service `floci` sin selector con EndpointSlice | «Es el equivalente local del DNS privado de los VPC Endpoints.» |
| Credenciales de los pods | `test/test` estático | «Los roles de mínimo privilegio y las Pod Identity associations están en Terraform; Floci no valida firmas.» |
| kubeconfig | Tras reiniciar Floci, el webhook del k3s rechaza el token IAM y se usa el admin del k3s | «En AWS el runner usaría `aws eks get-token` con una access entry.» |
| Un solo nodo | `desired_size = 2` en prod, pero un k3s de un nodo | «El tamaño está en `prod.tfvars`; el emulador levanta un nodo por clúster.» |
| WSS | Polling HTTP | Ver la sección 8.5. |
| Canary 20% | Por conexión, no por request | Ver la sección 8.2. |
| Canary del frontend | Access logs de nginx | «nginx estático no publica en CloudWatch; evalúo la misma condición, la tasa de 5xx del canary.» |
| Prefect | Docker Compose, fuera de EKS | Ver la sección 8.4. |

---

## 12. Trampas que cuestan puntos

1. **Corre `.\scripts\demo\preflight.ps1 -Fix` 30 minutos antes.** Levanta Floci y Prefect, corrige la IP de Floci y resincroniza el NLB.
2. **Arranca el runner** si el preflight dice FALLA: `C:\actions-runner-aegisvolt\run.cmd`.
3. **4 segundos** entre cambiar una flag y disparar la mutation, por el cache de 3 s.
4. **Antes de repetir un canary** tras un rollback, espera a que la alarma vuelva a `OK` (~3 min).
5. **Nunca cortes un `terraform plan`** con `Ctrl+C` ni con `| Select-Object -First`: deja el lock tomado. Si pasa: `terraform force-unlock <ID>`.
6. **Usa Chrome o Edge** para la UI. El navegador integrado de la app bloquea los assets de `*.localhost.floci.io`.
7. **Usa las URLs que imprime el preflight**: los ids de API Gateway cambian si se recrea la infraestructura.
8. **Deja todo limpio** tras cada bloque: flag de falla en OFF y canary en 0 (bloque 7 de [GUION-DEMO.md](GUION-DEMO.md)).
9. **Empieza la pregunta de red por el VPC Endpoint**, no por el VPC Link: es lo que pregunta el enunciado.
10. **Responde primero en una frase.** Después abre el archivo y ejecuta el comando.
