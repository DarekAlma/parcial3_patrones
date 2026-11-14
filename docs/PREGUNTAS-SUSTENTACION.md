# Preparación para la sustentación — preguntas, respuestas y ubicación en el código

> La evaluación es **binaria por pregunta**: una respuesta a medias vale cero. Cada entrada trae la **respuesta corta** (dila primero), el **archivo y la línea** que debes abrir y, cuando aplica, **cómo demostrarlo**.
> Las preguntas marcadas con ★ son las del banco oficial (sección 6 del enunciado). El detalle largo está en [sustentacion/](sustentacion/).

**Regla para responder:** una frase con la respuesta → abrir el archivo en la línea → ejecutar el comando. No empieces por el contexto.

---

## 1. Infraestructura como Código, S3 y redes (30%)

### ★ 1.1 ¿Cómo garantiza que un `terraform apply` en `test` no sobrescribe las tablas ni el estado de `prod`?

**Respuesta:** por cuatro barreras independientes.

| Barrera | Qué impide | Ubicación |
|---------|-----------|-----------|
| Estado separado por workspace | Que `test` lea o escriba el tfstate de `prod` | [versions.tf:28-34](../infra/terraform/versions.tf#L28) (`workspace_key_prefix = "env:"`) |
| Nombres derivados del workspace | Que dos ambientes produzcan el mismo nombre de recurso | [locals.tf:9-10](../infra/terraform/locals.tf#L9), [main.tf:21](../infra/terraform/main.tf#L21) |
| Guardas (`precondition`) | Aplicar un `tfvars` de otro ambiente, o usar el workspace `default` | [locals.tf:50-63](../infra/terraform/locals.tf#L50) |
| El pipeline verifica el workspace activo | Que el script aplique sobre un workspace distinto al pedido | [terraform.ps1:29-33](../scripts/ci/terraform.ps1#L29) |

**Demostración:** `terraform workspace select test` y luego `terraform plan "-var-file=environments/prod.tfvars"` → error «El tfvars es de 'prod' pero el workspace activo es 'test'».

### ★ 1.2 Muestre las versiones anteriores del tfstate de `dev` y cómo restauraría una versión previa

**Respuesta:** el bucket tiene versioning; cada `apply` deja una versión nueva. Para restaurar descargo la versión buena, valido su `lineage` y la subo con `terraform state push`. La versión corrupta queda en el historial.

- Versioning: [bootstrap/main.tf:35-40](../infra/bootstrap/main.tf#L35)
- Script: [restore-state.ps1](../scripts/infra/restore-state.ps1) (listar en la línea 21, validar `lineage` en la 43, `state push` en la 49)

**Demostración:** `.\scripts\infra\restore-state.ps1 -Environment dev`.

### ★ 1.3 Recorrido de un paquete desde API Gateway hasta el pod a través del VPCE; qué tabla de rutas o política interviene

**Respuesta (dila en este orden):**

1. Un workload dentro de la VPC resuelve el nombre de `execute-api` con el **DNS privado** hacia la **ENI del Interface VPCE `execute-api`**, en una subred privada.
2. El **security group `sg-vpce`** solo acepta 443 desde el CIDR de la VPC.
3. La **API REST `PRIVATE`** evalúa su **resource policy**: `Allow` solo si `aws:SourceVpce` es el VPCE del ambiente, `Deny` para todo lo demás.
4. API Gateway entrega la petición por el **VPC Link** al **NLB interno**.
5. La **tabla `rt-private`** solo tiene la ruta `local`: el paquete nunca sale de la VPC.
6. `sg-nlb` → `sg-nodes`: el NLB llega al **NodePort 30080** del nodo, y kube-proxy lo entrega al pod.

El tráfico público del navegador usa el mismo tramo final (VPC Link → NLB → NodePort → pod), pero entra por la HTTP API pública, no por el VPCE.

| Elemento | Ubicación |
|----------|-----------|
| Interface VPCE y `sg-vpce` | [network/main.tf:156-182](../infra/terraform/modules/network/main.tf#L156) |
| `rt-private` sin `0.0.0.0/0` | [network/main.tf:83-92](../infra/terraform/modules/network/main.tf#L83) |
| API privada y resource policy | [api-gateway/main.tf:223-260](../infra/terraform/modules/api-gateway/main.tf#L223) |
| VPC Link, NLB y target group | [api-gateway/main.tf:101-151](../infra/terraform/modules/api-gateway/main.tf#L101) |
| Cadena de security groups | [api-gateway/main.tf:30-96](../infra/terraform/modules/api-gateway/main.tf#L30) |
| NodePort del gateway | [graphql-gateway.yaml:28-35](../k8s/base/graphql-gateway.yaml#L28) |

**Si piden demostrarlo:** Floci no hace cumplir la policy ni muestra la ruta prefix-list. Muestra lo declarado (`describe-vpc-endpoints`, `describe-route-tables`, la policy de la API) y que Prefect compensa huérfanas «via API private».

### 1.4 ¿Para qué sirven las subredes públicas si no hay nada en ellas?

**Respuesta:** el enunciado las exige. Quedan con Internet Gateway y el tag `kubernetes.io/role/elb` para un balanceador de cara a Internet. Ningún componente vive ahí y no hay NAT, así que las privadas no tienen salida. — [network/main.tf:32-80](../infra/terraform/modules/network/main.tf#L32)

### 1.5 ¿Cómo salen los pods hacia DynamoDB, S3 y CloudWatch sin Internet?

**Respuesta:** DynamoDB y S3 por **Gateway VPCE** (ruta en `rt-private`); CloudWatch por **Interface VPCE** `logs` y `monitoring`. La policy del Gateway VPCE de DynamoDB solo permite tablas `aegisvolt-*-<env>`. — [network/main.tf:99-151](../infra/terraform/modules/network/main.tf#L99)

**En Floci:** los pods llegan al emulador por un Service sin selector llamado `floci` ([platform.yaml:11-27](../k8s/base/platform.yaml#L11)). Es el equivalente local del DNS privado de los endpoints.

### 1.6 ¿Por qué Gateway VPCE para unos servicios e Interface VPCE para otros?

**Respuesta:** S3 y DynamoDB son los únicos con endpoint tipo Gateway: funcionan por tabla de rutas, sin ENI y sin costo por hora. El resto solo existe como Interface (PrivateLink).

### 1.7 ¿Qué impide dos `apply` simultáneos sobre el mismo ambiente?

**Respuesta:** el lock nativo de S3 (`use_lockfile = true`, archivo `.tflock`) y `concurrency` por rama en el CD. — [versions.tf:33](../infra/terraform/versions.tf#L33), [cd.yml:21-23](../.github/workflows/cd.yml#L21)

### 1.8 ¿Dónde vive el estado del propio bucket (huevo y gallina)?

**Respuesta:** el bootstrap aplica con backend local temporal y luego migra su estado al bucket que acaba de crear (`init -migrate-state`). — [bootstrap.ps1:46](../scripts/infra/bootstrap.ps1#L46), [bootstrap/providers.tf:12-15](../infra/bootstrap/providers.tf#L12)

### 1.9 ¿Qué es Database-per-Service y cómo lo hace cumplir?

**Respuesta:** cada servicio es dueño de su tabla. Lo hacen cumplir los roles IAM: cada ServiceAccount escribe solo en su tabla. — tablas en [locals.tf:21-46](../infra/terraform/locals.tf#L21), permisos en [main.tf:68-89](../infra/terraform/main.tf#L68) y [eks/main.tf:242-269](../infra/terraform/modules/eks/main.tf#L242)

### 1.10 ¿El API server de EKS es público?

**Respuesta:** sí, con acceso público y privado, para que el runner alcance el clúster. El plano de datos (nodos y pods) está en subredes privadas. En producción se restringe `public_access_cidrs` a la IP del runner o se deja solo el endpoint privado. — [eks/main.tf:177-183](../infra/terraform/modules/eks/main.tf#L177), [variables.tf:71-74](../infra/terraform/variables.tf#L71)

### 1.11 ¿Qué recursos no crea Terraform?

**Respuesta:** los manifiestos de Kubernetes (los aplica el pipeline) y los **targets del NLB**, que registra el pipeline como lo haría el AWS Load Balancer Controller con un `TargetGroupBinding`. Terraform es dueño del NLB, el target group y el listener. — [deploy.ps1:78-93](../scripts/k8s/deploy.ps1#L78)

---

## 2. CI/CD, gobernanza de Git y canary (25%)

### ★ 2.1 Intente un push directo o un `--force` a `test` y muestre qué regla lo bloquea

**Respuesta:** el ruleset `protected-env-branches`. La regla `pull_request` bloquea el push directo y `non_fast_forward` bloquea el force push. `bypass_actors` está vacío: ni el dueño puede saltárselo. GitHub responde `GH013`.

- [protected-env-branches.json:5](../.github/rulesets/protected-env-branches.json#L5) (bypass), [líneas 12-25](../.github/rulesets/protected-env-branches.json#L12) (reglas)
- Se aplica con [setup-repo.ps1](../scripts/github/setup-repo.ps1)

### ★ 2.2 ¿Cómo determina el YAML sobre qué ambiente correr `terraform apply`?

**Respuesta:** el CD se dispara con `push` a `dev`, `test` o `prod`, y eso solo ocurre por un merge. El job `resolve-env` lee `github.ref_name`, lo valida y lo publica como output; `terraform-apply` lo pasa al script, que hace `workspace select` y `apply -auto-approve`.

- [cd.yml:16-18](../.github/workflows/cd.yml#L16) (disparador), [40-55](../.github/workflows/cd.yml#L40) (`resolve-env`), [57-65](../.github/workflows/cd.yml#L57) (`terraform-apply`)
- [terraform.ps1:29](../scripts/ci/terraform.ps1#L29) (`workspace select`), [línea 58](../scripts/ci/terraform.ps1#L58) (`apply -auto-approve`)

**No confundir:** en el CI (pull request) el ambiente es `github.base_ref` ([ci.yml:28](../.github/workflows/ci.yml#L28)).

### ★ 2.3 ¿Qué métrica o condición evalúa el canary antes de pasar del 20% al 100%?

**Respuesta:** cuatro condiciones, todas obligatorias:

1. El pod canary está `Ready` y sin reinicios.
2. `RequestCount(Track=canary) ≥ 5`: hubo tráfico real al canary.
3. `ErrorCount / RequestCount ≤ 5%`, leído de CloudWatch.
4. La alarma `aegisvolt-<env>-<servicio>-canary-errors` no está en `ALARM`.

Si una falla, el canary vuelve a 0 réplicas, stable queda intacto y el job falla.

- Gate: [canary-deploy.ps1:139-145](../scripts/ci/canary-deploy.ps1#L139); lectura de métricas en [117-136](../scripts/ci/canary-deploy.ps1#L117); promoción en [168-171](../scripts/ci/canary-deploy.ps1#L168)
- Metric filters y alarma: [observability/main.tf:27-32](../infra/terraform/modules/observability/main.tf#L27), [73-87](../infra/terraform/modules/observability/main.tf#L73)

### 2.4 ¿Cómo logra el 20% de tráfico?

**Respuesta:** dos Deployments con el mismo label y un Service que selecciona solo por ese label: 1 pod canary junto a 4 stable recibe 1 de cada 5 conexiones. Es un reparto estadístico por conexión, no exacto; un reparto exacto requiere service mesh o Argo Rollouts. El script lo mide contando las respuestas con el header `x-aegis-track: canary`. — [billing-wallet-service.yaml:27-30](../k8s/base/billing-wallet-service.yaml#L27) (selector), [45](../k8s/base/billing-wallet-service.yaml#L45) y [127](../k8s/base/billing-wallet-service.yaml#L127) (réplicas)

### 2.5 ¿Qué pasa si un servicio no cambió?

**Respuesta:** el tag de la imagen es un hash del contenido del servicio. Si coincide con la imagen stable no hay canary para ese servicio. — [canary-deploy.ps1:45-48](../scripts/ci/canary-deploy.ps1#L45)

### 2.6 ¿Cómo impide que una rama `feature/*` vaya directo a `test` o `prod`?

**Respuesta:** el job `promotion-guard` es un check obligatorio y solo acepta `feature/* → dev`, `dev → test` y `test → prod`. — [ci.yml:46-70](../.github/workflows/ci.yml#L46)

### 2.7 ¿Por qué solo merge commit?

**Respuesta:** para que `dev`, `test` y `prod` compartan los mismos commits. Un squash crearía commits distintos en cada rama y las haría divergir. — [protected-env-branches.json:23](../.github/rulesets/protected-env-branches.json#L23)

### 2.8 ¿El `apply` usa el mismo plan que se revisó en el PR?

**Respuesta:** no. El plan del PR queda adjunto como artifact y en el resumen del job; el `apply` vuelve a planificar sobre el mismo commit ya fusionado. Mejora posible: guardar el `tfplan` y aplicarlo. — [ci.yml:108-122](../.github/workflows/ci.yml#L108), [terraform.ps1:38-39](../scripts/ci/terraform.ps1#L38)

### 2.9 ¿Qué valida cada job del CI?

| Job | Qué valida | Script |
|-----|-----------|--------|
| `lint-build` | ESLint, tipos, build, esquema GraphQL, `terraform fmt` y `validate`, overlays de kustomize, `docker build` | [lint-build.ps1](../scripts/ci/lint-build.ps1) |
| `unit-tests` | Lógica de negocio y compensaciones de la SAGA | [test.ps1](../scripts/ci/test.ps1) |
| `integration-tests` | Repositorios contra DynamoDB y endpoints GraphQL | igual |
| `e2e-tests` | Flujo completo por GraphQL con los 4 servicios | igual |
| `terraform-plan` | Plan sobre el workspace de la rama destino | [terraform.ps1](../scripts/ci/terraform.ps1) |

### 2.10 ¿Por qué un runner self-hosted? ¿Es seguro en un repositorio público?

**Respuesta:** Floci vive en `localhost`, así que el pipeline debe correr en la misma máquina. `promotion-guard` rechaza los PR de forks antes de hacer checkout ([ci.yml:57-59](../.github/workflows/ci.yml#L57)). Con AWS real usaría runners hospedados con OIDC.

---

## 3. Backend, GraphQL, SAGA y feature flags (25%)

### ★ 3.1 Active la flag de fallo en `test`, dispare la mutation y demuestre la compensación en DynamoDB

**Respuesta:** la flag hace que `energy-dispatch-service` responda `422 CHARGER_HARDWARE_FAULT`. El orquestador compensa en orden inverso: reembolso en billing y después liberación en station.

| Evidencia | Tabla y clave | Código |
|-----------|---------------|--------|
| Cobro y reembolso | `aegisvolt-billing-test`: `WALLET#<flota>` / `TXN#<sagaId>#CHARGE` y `…#REFUND` | [billing/repository.ts:159-209](../services/billing-wallet-service/src/repository.ts#L159) |
| Reserva liberada | `aegisvolt-reservations-test`: `RESERVATION#<sagaId>` / `META` → `RELEASED` | [station/repository.ts:179-230](../services/station-reservation-service/src/repository.ts#L179) |
| Sesión fallida | `aegisvolt-dispatch-test`: `SESSION#<sagaId>` / `META` → `FAILED` | [dispatch/app.ts:46-67](../services/energy-dispatch-service/src/app.ts#L46) |
| Log de la SAGA | `aegisvolt-saga-test`: `SAGA#<sagaId>` / `META` → `COMPENSATED` | [engine.ts:170-226](../graphql-gateway/src/saga/engine.ts#L170) |

**Cuidado:** espera 4 s entre activar la flag y disparar la mutation. Cada pod lee la flag con cache de 3 s.

### ★ 3.2 ¿Cómo evita problemas de idempotencia si una compensación se procesa dos veces?

**Respuesta:** el `sagaId` forma parte de la clave de cada escritura, y cada escritura es condicional.

- El reembolso inserta `TXN#<sagaId>#REFUND` con `attribute_not_exists` **dentro de la misma transacción** que suma el saldo. Un segundo intento choca con la condición y devuelve `ALREADY_REFUNDED` sin mover dinero. — [billing/repository.ts:177-205](../services/billing-wallet-service/src/repository.ts#L177)
- La liberación exige `reservedBy = <sagaId>`; si ya se liberó devuelve `ALREADY_RELEASED`. — [station/repository.ts:179-230](../services/station-reservation-service/src/repository.ts#L179)
- El cobro usa la misma técnica: repetirlo devuelve `replayed: true`. — [billing/repository.ts:102-141](../services/billing-wallet-service/src/repository.ts#L102)
- La SAGA completa: `attribute_not_exists` al crear el registro; la misma `idempotencyKey` no la ejecuta dos veces. — [store.ts:29-40](../graphql-gateway/src/saga/store.ts#L29), [engine.ts:86-91](../graphql-gateway/src/saga/engine.ts#L86)

### 3.3 ¿Por qué orquestación y no coreografía?

**Respuesta:** un solo componente conoce la secuencia y guarda el log. El orden inverso de compensación es explícito y auditable. El costo es que el gateway queda acoplado a los tres servicios; con coreografía ese conocimiento quedaría repartido en eventos.

### 3.4 ¿Qué es el pivot y por qué `ACTIVATE_CHARGER`?

**Respuesta:** es el punto de no retorno. Antes de él todo se puede deshacer; después solo quedan pasos que se reintentan (`CONFIRM_RESERVATION`). Activar el cargador es físico: no se «des-entrega» energía. — [reserve-charge-saga.ts:88-113](../graphql-gateway/src/saga/reserve-charge-saga.ts#L88), [types.ts:1-12](../graphql-gateway/src/saga/types.ts#L1)

### 3.5 ¿Por qué primero el reembolso y después la liberación?

**Respuesta:** es el orden inverso al de ejecución. Así nunca queda la bahía libre con el saldo todavía retenido. — [engine.ts:176](../graphql-gateway/src/saga/engine.ts#L176)

### 3.6 ¿Qué pasa si el orquestador muere a mitad de una SAGA?

**Respuesta:** el log se persiste antes de cada transición, con versión optimista. La SAGA queda en un estado no terminal; el flow de Prefect la detecta tras 120 s sin avanzar y llama a `recoverTransaction`, que compensa lo hecho. Un paso que quedó `RUNNING` también se compensa, porque no se sabe si el servicio aplicó el efecto. — [engine.ts:232-246](../graphql-gateway/src/saga/engine.ts#L232), [store.ts:42-62](../graphql-gateway/src/saga/store.ts#L42)

### 3.7 ¿Y si un paso falla por timeout pero el servicio sí aplicó el cambio?

**Respuesta:** el motor distingue el rechazo definitivo (4xx de dominio, como fondos insuficientes) del fallo ambiguo (timeout, red, 5xx). En el ambiguo compensa también ese paso; como la compensación es idempotente, si no había nada que deshacer responde `NOTHING_TO_REFUND`. — [engine.ts:118-122](../graphql-gateway/src/saga/engine.ts#L118), [engine.ts:262-265](../graphql-gateway/src/saga/engine.ts#L262); pruebas en [saga-engine.unit.test.ts](../graphql-gateway/test/saga-engine.unit.test.ts)

**Límite conocido:** el pivot no tiene compensación propia. Si la activación se aplica y la respuesta se pierde, la sesión queda `ACTIVE` con el saldo reembolsado; la auditoría de Prefect la marca `INCONSISTENT` ([audit_rules.py:74-75](../prefect/aegisvolt_observability/audit_rules.py#L74)).

### 3.8 ¿Qué pasa si una compensación falla?

**Respuesta:** se reintenta hasta 4 veces con backoff exponencial. Si se agota, la SAGA queda `FAILED`, se emite `saga_failed` con nivel `ERROR` (dispara la alarma) y la auditoría la clasifica como «requiere atención». — [engine.ts:191-207](../graphql-gateway/src/saga/engine.ts#L191)

### 3.9 ¿Cómo evita que dos flotas reserven el mismo conector?

**Respuesta:** escritura condicional: el conector solo pasa a `RESERVED` si está `AVAILABLE` o si su bloqueo ya venció. Gana una; la otra recibe un error de dominio. — [station/repository.ts:132-157](../services/station-reservation-service/src/repository.ts#L132)

### 3.10 ¿Cómo logra que cada ambiente tenga su propio estado de flags?

**Respuesta:** una tabla por ambiente, `aegisvolt-feature-flags-<env>`. Terraform siembra el valor inicial desde el `tfvars` del ambiente e ignora cambios posteriores. — [feature-flags/main.tf:11-44](../infra/terraform/modules/feature-flags/main.tf#L11), [dev.tfvars:22-35](../infra/terraform/environments/dev.tfvars#L22), [prod.tfvars:23-36](../infra/terraform/environments/prod.tfvars#L23)

### 3.11 ¿Cómo cambia una flag sin redesplegar?

**Respuesta:** la flag es un dato en DynamoDB, no una variable de entorno. Cada pod la lee con cache de 3 s. — [flags.ts:42-53](../packages/common/src/flags.ts#L42); mutation en [resolvers.ts:153-166](../graphql-gateway/src/resolvers.ts#L153)

### 3.12 ¿Quién puede cambiar flags o llamar `recoverTransaction`?

**Respuesta:** hoy la API no tiene autenticación; la autorización estaba fuera del alcance del enunciado. En prod `setFeatureFlag` está bloqueado por configuración. En un sistema real pondría un authorizer JWT en API Gateway y dejaría las mutations administrativas solo en la API privada. — [resolvers.ts:154-158](../graphql-gateway/src/resolvers.ts#L154), [overlays/prod/kustomization.yaml:25](../k8s/overlays/prod/kustomization.yaml#L25)

### 3.13 ¿Dónde está el desacople entre microservicios?

**Respuesta:** tabla propia, rol IAM propio, Deployment propio y contrato HTTP. La NetworkPolicy solo deja que el gateway los llame. — [platform.yaml:41-65](../k8s/base/platform.yaml#L41)

---

## 4. Observabilidad (12%)

### ★ 4.1 Muestre el flujo en Prefect y rastree en CloudWatch el `correlation_id` de una SAGA fallida

**Respuesta:** el `sagaId` es el `correlation_id`. El gateway lo envía en el header `x-correlation-id` y cada servicio lo incluye en todos sus logs. Una consulta de Logs Insights sobre los 4 log groups del ambiente reconstruye la línea de tiempo.

- Header y logger hijo: [server.ts:41-46](../packages/common/src/server.ts#L41); propagación: [http-client.ts:43](../packages/common/src/http-client.ts#L43)
- Formato del log: [logger.ts:96-104](../packages/common/src/logger.ts#L96); log groups: [observability/main.tf:43-48](../infra/terraform/modules/observability/main.tf#L43)
- Consulta: [trace-saga.ps1](../scripts/demo/trace-saga.ps1)

### 4.2 ¿Qué hace cada flow de Prefect?

| Flow | Tasks | Ubicación |
|------|-------|-----------|
| `environment-health` | API Gateway, clúster EKS, tablas, targets del NLB, alarmas, flags | [health.py](../prefect/aegisvolt_observability/health.py) |
| `saga-consistency-audit` | Cargar SAGAs, auditar, recuperar huérfanas, publicar métricas | [saga_audit.py:116](../prefect/aegisvolt_observability/saga_audit.py#L116) |

### 4.3 ¿Cómo detecta una SAGA huérfana o inconsistente?

**Respuesta:** **huérfana** = estado no terminal y más de 120 s sin avanzar. **Inconsistente** = estado terminal que no coincide con las tablas de los servicios; por ejemplo `COMPENSATED` con cobro y sin reembolso. — [audit_rules.py:55-100](../prefect/aegisvolt_observability/audit_rules.py#L55), cruce con las tablas en [saga_audit.py:49-66](../prefect/aegisvolt_observability/saga_audit.py#L49)

### 4.4 ¿Cómo llegan los logs a CloudWatch?

**Respuesta:** el logger hace `PutLogEvents` por lotes cada 2 s al log group `/aegisvolt/<env>/<servicio>`. Si CloudWatch falla, el servicio sigue y el log queda en stdout. La alternativa habitual es Fluent Bit como DaemonSet. — [logger.ts:40-84](../packages/common/src/logger.ts#L40)

### 4.5 ¿Por qué Prefect corre fuera del clúster?

**Respuesta:** es el plano de observabilidad: si viviera en el clúster que vigila, caería con él. Además vigila los tres ambientes a la vez. — [prefect/docker-compose.yml](../prefect/docker-compose.yml)

---

## 5. Frontend (8%)

### ★ 5.1 Cambie una flag en `dev` sin redesplegar y muestre que `prod` no cambia

**Respuesta:** el interruptor llama a la mutation `setFeatureFlag` del API de dev, que escribe en `aegisvolt-feature-flags-dev`. La UI vuelve a leer las flags cada 4 s. El tablero de lámparas consulta también las APIs de test y prod, que tienen otra tabla.

- Polling: [App.tsx:23](../frontend/src/App.tsx#L23), [graphql.ts:33-77](../frontend/src/lib/graphql.ts#L33)
- Tablero de los otros ambientes: [ServiceCabinet.tsx:25-46](../frontend/src/components/ServiceCabinet.tsx#L25)

**Prueba de que no hubo redespliegue:** `kubectl get pods` muestra la misma antigüedad antes y después.

### 5.2 ¿Cómo sabe el frontend en qué ambiente está?

**Respuesta:** no lo sabe al compilar. La misma imagen consulta `environment` por GraphQL en su propio origen. Las URLs de los otros ambientes llegan por el ConfigMap `frontend-config`. — [config.ts](../frontend/src/lib/config.ts), [deploy.ps1:64-76](../scripts/k8s/deploy.ps1#L64)

### 5.3 ¿Por qué polling y no WebSocket?

**Respuesta:** el enunciado pide tiempo real, no un protocolo. Con polling de 2 a 5 s la UI se sirve por la misma HTTP API y el mismo origen. Las subscriptions exigirían una WebSocket API aparte y conexiones persistentes que atraviesen el VPC Link.

### 5.4 ¿Cómo se sirve la UI?

**Respuesta:** nginx sin privilegios dentro del clúster, detrás del mismo API Gateway: `GET /` y `GET /{proxy+}` van al frontend y `/graphql` al gateway. — [api-gateway/frontend.tf:82-98](../infra/terraform/modules/api-gateway/frontend.tf#L82), [frontend/nginx.conf](../frontend/nginx.conf)

---

## 6. Desviaciones respecto a AWS real — frase lista

| Tema | Frase |
|------|-------|
| Ruta prefix-list | «El Gateway VPCE está asociado a `rt-private` en Terraform. AWS inyecta la ruta; Floci guarda la asociación pero no la materializa.» |
| Policy de la API privada | «La resource policy está declarada con `Allow` y `Deny` por `aws:SourceVpce`. El emulador no evalúa resource policies.» |
| Salida de los pods | «El Service `floci` es el equivalente local del DNS privado de los VPC Endpoints.» |
| Credenciales | «Los roles de mínimo privilegio y las Pod Identity associations están en Terraform. Floci no valida firmas, por eso existe el Secret `test/test`.» |
| kubeconfig | «Tras reiniciar el emulador, su webhook rechaza el token de `aws eks get-token`. En AWS el runner usaría ese token con una access entry.» |
| Un nodo | «`desired_size = 2` está en `prod.tfvars`; Floci levanta un k3s de un nodo por clúster.» |
| E2E | «Corre antes del merge, así que no puede usar un ambiente que aún no recibió el cambio. Levanta los 4 servicios reales contra DynamoDB con tablas efímeras.» |
| Canary del frontend | «nginx estático no publica en CloudWatch. Evalúo la misma condición, la tasa de 5xx del canary, desde sus access logs.» |
