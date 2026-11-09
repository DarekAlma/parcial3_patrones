# Capa 1 — Infraestructura como Código, S3 y Redes (30%)

> Guía de sustentación. Cada pregunta trae: **respuesta corta** (lo que se dice primero), **detalle** y **dónde está en el código**.

## Mapa rápido

| Qué | Dónde |
|-----|-------|
| Bucket S3 versionado del tfstate | [infra/bootstrap/main.tf](../../infra/bootstrap/main.tf) |
| Script que crea el backend (huevo y gallina) | [scripts/infra/bootstrap.ps1](../../scripts/infra/bootstrap.ps1) |
| Backend S3 + workspaces | [infra/terraform/versions.tf](../../infra/terraform/versions.tf) |
| Ambiente derivado del workspace + guardas | [infra/terraform/locals.tf](../../infra/terraform/locals.tf) |
| Composición de módulos | [infra/terraform/main.tf](../../infra/terraform/main.tf) |
| Valores por ambiente | [infra/terraform/environments/](../../infra/terraform/environments/) |
| VPC, subredes, VPCE | [modules/network](../../infra/terraform/modules/network/main.tf) |
| DynamoDB Database-per-Service | [modules/dynamodb](../../infra/terraform/modules/dynamodb/main.tf) |
| Feature flags por ambiente | [modules/feature-flags](../../infra/terraform/modules/feature-flags/main.tf) |
| EKS + Pod Identity | [modules/eks](../../infra/terraform/modules/eks/main.tf) |
| API Gateway + VPC Link + NLB + API privada | [modules/api-gateway](../../infra/terraform/modules/api-gateway/main.tf) |
| CloudWatch logs, métricas, alarmas | [modules/observability](../../infra/terraform/modules/observability/main.tf) |
| Floci persistente | [infra/floci/docker-compose.yml](../../infra/floci/docker-compose.yml) |
| Restaurar un tfstate | [scripts/infra/restore-state.ps1](../../scripts/infra/restore-state.ps1) |

## Estructura de Terraform

```
infra/
├── bootstrap/                 # Stack 1: el backend (bucket S3 versionado)
└── terraform/                 # Stack 2: la plataforma (1 código, 3 workspaces)
    ├── versions.tf            # backend "s3" + workspace_key_prefix "env:"
    ├── providers.tf           # endpoints Floci + default_tags
    ├── locals.tf              # environment = terraform.workspace + guardas
    ├── main.tf                # composición de módulos
    ├── environments/{dev,test,prod}.tfvars
    └── modules/{network,dynamodb,feature-flags,observability,eks,api-gateway}
```

Hay **dos stacks separados**. El bucket del estado no puede vivir en el mismo estado que guarda: si un `destroy` de la plataforma borrara el bucket, se perdería el historial de todos los ambientes. Por eso el bucket tiene además `prevent_destroy = true`.

---

## Pregunta guía 1

### ¿Cómo garantiza su código de Terraform que al ejecutar `terraform apply` en la rama `test` no se sobrescriban las tablas de DynamoDB ni el estado del ambiente `prod` en S3?

**Respuesta corta:** hay cuatro capas de aislamiento.
1. Cada ambiente es un **workspace** distinto, con su propia *key* en S3.
2. Todos los nombres de recursos se derivan de `terraform.workspace`.
3. Una **guarda** impide aplicar con un tfvars de otro ambiente.
4. El pipeline selecciona el workspace según la rama destino y verifica que sea el correcto antes del apply.

**Detalle:**

1. **Estado separado por workspace.** En [versions.tf](../../infra/terraform/versions.tf) el backend usa `workspace_key_prefix = "env:"`. Terraform guarda cada workspace en una key distinta:
   ```
   s3://aegisvolt-tfstate/env:/dev/aegisvolt/terraform.tfstate
   s3://aegisvolt-tfstate/env:/test/aegisvolt/terraform.tfstate
   s3://aegisvolt-tfstate/env:/prod/aegisvolt/terraform.tfstate
   ```
   Con `terraform workspace select test`, Terraform **solo lee y escribe** `env:/test/...`. El estado de prod no se carga y ningún recurso de prod aparece en el plan, así que es imposible modificarlo.

2. **Nombres derivados del workspace.** En [locals.tf](../../infra/terraform/locals.tf) se define `environment = terraform.workspace`. No existe una variable `environment` editable. Todos los nombres salen de ahí:
   - Tablas: `aegisvolt-reservations-test`, `aegisvolt-billing-test`, …
   - Log groups: `/aegisvolt/test/<servicio>`
   - Clúster: `aegisvolt-test`, VPC `aegisvolt-test-vpc`

   Dos workspaces nunca generan el mismo nombre, así que no hay colisión aunque compartan cuenta y región.

3. **Guardas (`precondition`).** El recurso `terraform_data.workspace_guard` falla en el plan si:
   - el workspace no es `dev`, `test` o `prod` (por ejemplo `default`);
   - `expected_environment` del tfvars no coincide con el workspace. Si alguien corre `-var-file=environments/prod.tfvars` estando en `test`, el plan se aborta.

4. **Pipeline.** [scripts/ci/terraform.ps1](../../scripts/ci/terraform.ps1) recibe el ambiente desde la rama destino del merge. Luego:
   - ejecuta `terraform workspace select -or-create <env>`;
   - **verifica** con `terraform workspace show` que el workspace activo sea el esperado y, si no, aborta;
   - usa `environments/<env>.tfvars`.

5. **Extras de protección:**
   - **Locking:** `use_lockfile = true` crea `terraform.tfstate.tflock` con escritura condicional en S3 (`If-None-Match`). Dos applies simultáneos sobre el mismo ambiente fallan con `412 PreconditionFailed`. El workflow de CD además usa `concurrency: cd-<env>`.
   - **Prod:** `dynamodb_deletion_protection = true` y `dynamodb_pitr = true` en [prod.tfvars](../../infra/terraform/environments/prod.tfvars). Aunque un plan intentara borrar una tabla de prod, DynamoDB lo rechaza.
   - **Etiquetas:** `default_tags` agrega `Environment` y `Workspace` a cada recurso, para auditar de qué ambiente es cada uno.

**Demostración en vivo:**
```powershell
cd infra/terraform
terraform workspace list                       # * dev, test, prod
terraform workspace select test
terraform plan "-var-file=environments/prod.tfvars"
# Error: El tfvars es de 'prod' pero el workspace activo es 'test'.
aws --endpoint-url http://localhost:4566 s3 ls --recursive s3://aegisvolt-tfstate/
```

---

## Pregunta guía 2

### Muestre en su bucket S3 las versiones anteriores del `terraform.tfstate` del workspace `dev` y explique cómo restauraría la versión previa ante un cambio corrupto.

**Respuesta corta:** el bucket `aegisvolt-tfstate` tiene **Versioning Enabled**. Cada `apply` sube una versión nueva del tfstate y conserva las anteriores con su `VersionId`. Para restaurar: localizo la versión buena con `list-object-versions`, la descargo con su `VersionId`, la valido y la vuelvo a subir como versión actual. El script [restore-state.ps1](../../scripts/infra/restore-state.ps1) automatiza esos pasos.

**Listar versiones:**
```powershell
$env:AWS_ENDPOINT_URL="http://localhost:4566"
aws s3api list-object-versions --bucket aegisvolt-tfstate `
  --prefix "env:/dev/aegisvolt/terraform.tfstate" `
  --query "Versions[?Key=='env:/dev/aegisvolt/terraform.tfstate'].{Version:VersionId,Fecha:LastModified,Actual:IsLatest,Bytes:Size}" `
  --output table
# (el filtro por Key excluye terraform.tfstate.tflock, el archivo de lock que vive al lado)
```
También en la consola de Floci: `http://localhost:4566/_floci/ui` → S3 → `aegisvolt-tfstate` → versiones.

**Restaurar (manual, paso a paso):**
```powershell
# 1. Descargar la version buena
aws s3api get-object --bucket aegisvolt-tfstate --key "env:/dev/aegisvolt/terraform.tfstate" `
  --version-id <VERSION_ID> restored.tfstate
# 2. Validar que es un JSON de estado valido (serial, lineage, recursos)
Get-Content restored.tfstate | ConvertFrom-Json | Select-Object serial, lineage
# 3. Subirla como version actual (la corrupta queda como version anterior: nada se pierde)
cd infra/terraform; terraform workspace select dev
terraform state push -force restored.tfstate
# 4. Verificar que el estado coincide con la realidad
terraform plan "-var-file=environments/dev.tfvars"
```

**Restaurar (script):**
```powershell
.\scripts\infra\restore-state.ps1 -Environment dev              # lista versiones
.\scripts\infra\restore-state.ps1 -Environment dev -VersionId X  # restaura
```

**Puntos a destacar:**
- **Restaurar no borra nada.** La versión corrupta queda en el historial, porque el versionamiento nunca sobrescribe. Restaurar crea una versión nueva cuyo contenido es el de la versión buena.
- **Por qué `terraform state push` y no un `s3 cp` directo:** Terraform valida `lineage` (que sea el mismo estado) y `serial`. Además respeta el lock, así que no se pisa un apply en curso. Se usa `-force` porque el serial restaurado es menor que el actual.
- **Retención:** la regla de lifecycle `noncurrent_version_expiration` conserva las versiones antiguas 365 días. Las cargas multipart incompletas se limpian a los 7 días.
- **Después de restaurar** siempre hay que correr `terraform plan`. Si un recurso se creó después de la versión restaurada, el plan lo mostrará y se decide si se importa (`terraform import`) o se recrea.

---

## Pregunta guía 3

### Explique el recorrido de un paquete de red desde el API Gateway hasta el pod en Kubernetes a través del VPC Endpoint (VPCE), y qué tabla de enrutamiento o política de seguridad interviene.

**Respuesta corta:** hay dos caminos.
- **Público:** Cliente → API Gateway HTTP API → **VPC Link** (ENIs en subredes privadas) → **NLB interno** → NodePort 30080 del nodo EKS → kube-proxy → pod.
- **Interno:** un workload de la VPC llama al API Gateway por el **Interface VPCE `execute-api`**, gracias al DNS privado. La API privada solo acepta tráfico de ese VPCE (`aws:SourceVpce`).

Las subredes privadas **no tienen ruta a Internet**. La salida de los pods hacia DynamoDB y S3 va por los **Gateway VPCE**, a través de rutas *prefix-list* en `rt-private`.

```
                         ┌─────────────────────────────── VPC aegisvolt-<env> (10.X0.0.0/16) ───────────────────────────────┐
 Cliente                 │  Subredes PRIVADAS (rt-private: local + pl-dynamodb→vpce + pl-s3→vpce, SIN 0.0.0.0/0)          │
   │ HTTPS               │                                                                                                  │
   ▼                     │   ┌──────────────┐  sg-vpclink→sg-nlb   ┌──────────────┐  sg-nlb→sg-nodes   ┌──────────────────┐ │
 API Gateway  ─────────────► │ VPC Link ENI │ ──── TCP 1808X ────► │ NLB interno  │ ──── TCP 30080 ──► │ Nodo EKS         │ │
 HTTP API                │   └──────────────┘                      └──────────────┘                    │ kube-proxy       │ │
 (aegisvolt-<env>)       │                                                                            │  → Service       │ │
                         │                                                                            │  → Pod graphql   │ │
                         │                                                                            └────────┬─────────┘ │
                         │   Pod ──DNS privado──► Interface VPCE execute-api ──► API privada (SourceVpce)       │           │
                         │   Pod ──────────────► Gateway VPCE DynamoDB (policy: tablas *-<env>) ◄──────────────┘           │
                         │   Pod ──────────────► Interface VPCE logs/monitoring (CloudWatch)                                │
                         └──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Paso a paso (camino público):**

| # | Salto | Qué decide el camino | Código |
|---|-------|----------------------|--------|
| 1 | Cliente → API Gateway | Ruta `ANY /graphql` del HTTP API, con throttling por ambiente | `aws_apigatewayv2_route`, `aws_apigatewayv2_stage` |
| 2 | API Gateway → VPC Link | Integración `HTTP_PROXY` con `connection_type = VPC_LINK`. El VPC Link crea ENIs en las **subredes privadas** | `aws_apigatewayv2_integration`, `aws_apigatewayv2_vpc_link` |
| 3 | VPC Link → NLB | La ENI usa `sg-vpclink`, cuya salida solo permite el puerto del listener hacia `sg-nlb`. La ruta es la `local` de la VPC en `rt-private` | `aws_vpc_security_group_egress_rule.vpc_link_to_nlb` |
| 4 | NLB → nodo | Listener TCP → target group `target_type = ip`, puerto **30080**. `sg-nlb` solo acepta tráfico de `sg-vpclink`/VPC y solo sale al NodePort de `sg-nodes` | `aws_lb_listener`, `aws_lb_target_group` |
| 5 | Nodo → pod | `sg-nodes` acepta los NodePorts (30000–32767) **solo desde el CIDR de la VPC**. kube-proxy (iptables) reenvía del NodePort al Service `graphql-gateway` y de ahí a un pod `stable` o `canary` | `aws_vpc_security_group_ingress_rule.nodes_nodeport_from_vpc` |
| 6 | Pod → DynamoDB | El SDK resuelve `dynamodb.us-east-1.amazonaws.com`. `rt-private` tiene la ruta prefix-list de DynamoDB → **Gateway VPCE**. La **endpoint policy** solo permite tablas `aegisvolt-*-<env>` | `aws_vpc_endpoint.dynamodb` |
| 7 | Pod → CloudWatch | El DNS privado resuelve `logs.us-east-1.amazonaws.com` a las IPs de las ENIs del **Interface VPCE**. `sg-vpce` acepta 443 solo desde la VPC | `aws_vpc_endpoint.interface["logs"]` |

**Qué tablas de enrutamiento y políticas intervienen:**
- **`rt-public`**: `0.0.0.0/0 → IGW`. Solo la usan las subredes públicas; ningún componente de la plataforma vive en ellas.
- **`rt-private`**: ruta `local` (VPC) y rutas *prefix-list* de S3 y DynamoDB hacia sus Gateway VPCE. **No tiene `0.0.0.0/0`**: no hay NAT ni salida a Internet, así que el tráfico interno no puede salir a la Internet pública.
- **Security groups encadenados**: `sg-vpclink` → `sg-nlb` → `sg-nodes`. Cada uno solo acepta tráfico del anterior (referencia por SG, no por IP).
- **Endpoint policies**: el VPCE de DynamoDB solo permite tablas del propio ambiente. Si un pod de `test` intentara tocar `aegisvolt-billing-prod`, el VPCE lo rechaza.
- **Resource policy de la API privada**: `Allow` solo con `aws:SourceVpce = <vpce execute-api del ambiente>` y `Deny` para todo lo demás.
- **IAM (Pod Identity)**: cada ServiceAccount tiene un rol que solo puede escribir en su propia tabla.

**Cómo verificarlo en vivo:**
```powershell
$env:AWS_ENDPOINT_URL="http://localhost:4566"
# Tabla privada: sin 0.0.0.0/0
aws ec2 describe-route-tables --filters Name=tag:Name,Values=aegisvolt-dev-rt-private `
  --query "RouteTables[0].Routes[].[DestinationCidrBlock,DestinationPrefixListId,GatewayId]" --output table
# Gateway VPCE asociados a rt-private + su policy
aws ec2 describe-vpc-endpoints --filters Name=tag:Name,Values=aegisvolt-dev-vpce-dynamodb `
  --query "VpcEndpoints[0].{Tipo:VpcEndpointType,RouteTables:RouteTableIds,Policy:PolicyDocument}"
# Interface VPCE con DNS privado
aws ec2 describe-vpc-endpoints --filters Name=vpc-endpoint-type,Values=Interface Name=tag:Name,Values=aegisvolt-dev-* `
  --query "VpcEndpoints[].[ServiceName,PrivateDnsEnabled,State]" --output table
```

> **Limitación de Floci (decirla si preguntan):** en AWS real, asociar un Gateway VPCE a `rt-private` inyecta automáticamente la ruta `pl-xxxx (prefix list) → vpce-xxxx`. Floci guarda la asociación (`RouteTableIds`), pero no materializa esa ruta en `describe-route-tables`. En la demo hay que mostrar la asociación del endpoint y la prefix list (`aws ec2 describe-prefix-lists`). Las reglas de salida de `sg-nodes` sí apuntan a esas prefix lists.

**Por qué NLB y no ALB:** el VPC Link de API Gateway se conecta a un NLB. El NLB trabaja en capa 4 y no termina HTTP, así que el enrutamiento HTTP lo hace API Gateway y el canary lo hace Kubernetes.

**Quién registra los targets del NLB:** Terraform es dueño del NLB, del target group y del listener. Los targets (IP del nodo : NodePort) los registra el pipeline de despliegue, igual que el AWS Load Balancer Controller con un `TargetGroupBinding` en EKS real. Así un reemplazo de nodos no requiere un `terraform apply`.

---

## Otras preguntas probables

**¿Por qué workspaces y no una carpeta por ambiente?** El enunciado exige workspaces. Además hay un único código y la diferencia entre ambientes está solo en el `.tfvars`. Así es imposible que `prod` tenga un módulo distinto al que se probó en `test`: lo que se promueve es el mismo código.

**¿Qué pasa si alguien ejecuta Terraform en el workspace `default`?** La `precondition` de `terraform_data.workspace_guard` aborta el plan con el mensaje `Workspace 'default' invalido`.

**¿Cómo resolvió el “huevo y la gallina” del bucket del estado?** Con [bootstrap.ps1](../../scripts/infra/bootstrap.ps1):
1. Genera un `backend_override.tf` con backend **local** temporal y crea el bucket.
2. Borra el override y ejecuta `terraform init -migrate-state`, que sube el estado del propio bootstrap a `s3://aegisvolt-tfstate/bootstrap/terraform.tfstate`.

Así **todos** los tfstate quedan en S3, como pide el enunciado.

**¿Por qué Floci en modo `persistent`?** Por defecto Floci guarda todo en memoria. Si se reinicia el contenedor se pierden el bucket, las versiones del tfstate y las tablas. [docker-compose.yml](../../infra/floci/docker-compose.yml) usa `FLOCI_STORAGE_MODE=persistent` con el volumen `aegisvolt-floci-data`.

**¿Cómo pasaría esto a AWS real?** Hay que hacer tres cambios:
1. `aws_endpoint = null`, para que el provider use los endpoints reales.
2. Quitar del backend las líneas marcadas como *Floci*.
3. Cambiar los runners de CI a `ubuntu-latest` con OIDC (`aws-actions/configure-aws-credentials`).

El resto del código no cambia.

**¿Por qué Gateway VPCE para S3/DynamoDB e Interface VPCE para el resto?** S3 y DynamoDB son los únicos servicios con *Gateway endpoint*: funcionan por tabla de rutas, sin ENIs y sin costo por hora. Los demás (`execute-api`, `logs`, `monitoring`, `sts`, `ecr.*`, `eks`) solo existen como *Interface endpoint*: crean ENIs en las subredes privadas con DNS privado.

**¿Por qué cada ambiente tiene un CIDR distinto (10.10/10.20/10.30)?** Para poder conectar las VPC en el futuro (peering o Transit Gateway) sin solapes, y para identificar el ambiente con solo ver una IP.

**¿Cómo se diseñaron las tablas DynamoDB?** Database-per-Service, una tabla por servicio y ambiente, con clave genérica `pk`/`sk` (single-table design dentro de cada servicio):

| Tabla | Dueño | Claves e índices | Notas |
|-------|-------|------------------|-------|
| `aegisvolt-reservations-<env>` | station-reservation-service | `pk/sk` + `gsi1` | TTL `expiresAt` = bloqueo temporal de bahías |
| `aegisvolt-billing-<env>` | billing-wallet-service | `pk/sk` | Billeteras y transacciones (cargo / reembolso) |
| `aegisvolt-dispatch-<env>` | energy-dispatch-service | `pk/sk` | Sesiones de carga y telemetría (TTL de retención) |
| `aegisvolt-saga-<env>` | graphql-gateway (orquestador) | `pk/sk` + `gsi1` por estado | Log de la SAGA; Prefect lo audita |
| `aegisvolt-feature-flags-<env>` | feature flags | `flag` | Estado independiente por ambiente |

Ningún servicio lee la tabla de otro: el aislamiento lo refuerzan IAM (Pod Identity) y la policy del VPCE.

**¿Cómo se evita que un `terraform apply` revierta un cambio de feature flag hecho en caliente?** Los items de flags tienen `lifecycle { ignore_changes = [item] }`. Terraform siembra el valor inicial y después el estado en runtime es la fuente de verdad.
