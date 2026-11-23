# Guion de demo — Sustentación AegisVolt

> Orden según el peso de la rúbrica (IaC 30% → CI/CD 25% → SAGA 25% → Observabilidad 12% → Frontend 8%).
> Cada bloque trae la **frase de apertura**, los **comandos exactos**, **qué mostrar** y el **Plan B**.
> El detalle teórico de cada respuesta está en [docs/sustentacion/](sustentacion/). Preguntas con respuesta y ubicación en el código: [PREGUNTAS-SUSTENTACION.md](PREGUNTAS-SUSTENTACION.md).

## Cronograma (≈ 25 min)

| Bloque | Tiempo | Qué demuestra | Pregunta guía |
|--------|--------|---------------|---------------|
| 1. Apertura | 2 min | Arquitectura y aislamiento por ambiente | — |
| 2. IaC | 7 min | Workspaces, versiones del tfstate, recorrido por VPCE | 6.1 (las tres) |
| 3. CI/CD | 6 min | Push bloqueado, ambiente dinámico, canary con rollback | 6.2 (las tres) |
| 4. SAGA y flags | 6 min | Falla inducida, compensación en tablas, idempotencia | 6.3 (las dos) |
| 5. Observabilidad | 3 min | Prefect y `correlation_id` en CloudWatch | 6.4 (primera) |
| 6. Frontend | 2 min | Flag en dev sin redesplegar, prod intacto | 6.4 (segunda) |

**Cinco reglas para no perder puntos**

1. Responde primero en una frase; después abre el archivo y ejecuta el comando.
2. Tras cambiar una flag, **cuenta 4 segundos** antes de disparar la mutation: cada pod la lee con cache de 3 s.
3. En la pregunta del recorrido de red, **empieza por el VPC Endpoint**, no por el VPC Link (bloque 2.3).
4. Si algo no es demostrable por ser Floci, dilo tú antes de que lo pregunten y muestra lo declarado en Terraform.
5. Al terminar cada bloque deja el ambiente como estaba: flag de falla apagada, canary en 0.

---

## 0. Antes de entrar (T−30 min)

### 0.1 Encender todo y verificar

1. Abre Docker Desktop y espera a que diga *Engine running*.
2. Ejecuta el chequeo previo. `-Fix` levanta Floci y Prefect si están abajo:
   ```powershell
   cd C:\Users\rogst\Downloads\Patrones\parcial3_patrones
   .\scripts\demo\preflight.ps1 -Fix
   ```
   Debe terminar en **«Todo listo para la demo.»** con 20 chequeos en OK, e imprime las **URLs del día**.
3. Si el runner no aparece, ábrelo en otra terminal:
   ```powershell
   C:\actions-runner-aegisvolt\run.cmd
   ```

> Los ids de API Gateway (las URLs de las UI) cambian si se recrea la infraestructura. Usa siempre las que imprime el chequeo previo.

### 0.2 Pestañas abiertas (navegador normal, no el integrado)

| # | Pestaña | URL |
|---|---------|-----|
| 1 | UI **dev** | `http://<id-dev>.execute-api.localhost.floci.io:4566/` |
| 2 | UI **test** | `http://<id-test>.execute-api.localhost.floci.io:4566/` |
| 3 | UI **prod** | `http://<id-prod>.execute-api.localhost.floci.io:4566/` |
| 4 | Prefect | http://localhost:4200 |
| 5 | GitHub: Actions + PR #8 (`test → prod`) | https://github.com/DarekAlma/parcial3_patrones/actions |
| 6 | GitHub: Rulesets | https://github.com/DarekAlma/parcial3_patrones/settings/rules |
| 7 | Floci UI (S3, DynamoDB) | http://localhost:4566/_floci/ui |
| 8 | VS Code abierto en el repo | `docs/README.md` (mapa de "dónde está cada cosa") |

### 0.3 Terminal de la demo (pegar una sola vez)

```powershell
cd C:\Users\rogst\Downloads\Patrones\parcial3_patrones
$env:AWS_ENDPOINT_URL="http://localhost:4566"; $env:AWS_DEFAULT_REGION="us-east-1"
$env:AWS_ACCESS_KEY_ID="test"; $env:AWS_SECRET_ACCESS_KEY="test"
function Api($e) { "http://$(aws apigatewayv2 get-apis --query "Items[?Name=='aegisvolt-$e'].ApiId|[0]" --output text).execute-api.localhost.floci.io:4566" }
$DEV = Api dev; $TEST = Api test; $PROD = Api prod
function Gql($base, $q) { Invoke-RestMethod -Method Post -Uri "$base/graphql" -ContentType application/json -Body (@{query=$q}|ConvertTo-Json -Compress) | ConvertTo-Json -Depth 8 }
$KDEV = "$HOME\.kube\aegisvolt-dev.yaml"
```

---

## 1. Apertura: arquitectura (1–2 min)

**Frase:** «AegisVolt reserva bahías de carga, retiene saldo y activa el cargador como **una transacción distribuida** sobre tres microservicios. Cada ambiente, dev, test y prod, es una copia aislada: su propio workspace de Terraform, su propia VPC, sus propias tablas, su clúster y su API Gateway.»

**Qué mostrar:** el diagrama de [sustentacion/03-backend-saga.md](sustentacion/03-backend-saga.md#arquitectura) y el recorrido de red de [01-infraestructura-iac.md](sustentacion/01-infraestructura-iac.md#pregunta-guía-3).

---

## 2. IaC, S3 y redes (30%)

### 2.1 Workspaces: test no puede tocar prod

**Frase:** «El ambiente sale del workspace, no de una variable. Cada workspace tiene su propia key en S3 y todos los nombres se derivan de `terraform.workspace`.»

```powershell
cd infra\terraform
terraform init -input=false -reconfigure | Out-Null
terraform workspace list                                   # * dev / test / prod
terraform workspace select test
terraform plan "-var-file=environments/prod.tfvars"        # guarda: "El tfvars es de 'prod' pero el workspace activo es 'test'."
terraform workspace select default
terraform plan "-var-file=environments/dev.tfvars"         # guarda: "Workspace 'default' invalido..."
terraform workspace select dev; cd ..\..
aws s3 ls --recursive s3://aegisvolt-tfstate/ | Select-String -NotMatch tflock
aws dynamodb list-tables --query "TableNames" --output table   # aegisvolt-<servicio>-<env>
```

**Código a señalar:** [locals.tf](../infra/terraform/locals.tf) (`environment = terraform.workspace` y `workspace_guard`) y [versions.tf](../infra/terraform/versions.tf) (`workspace_key_prefix = "env:"`).

### 2.2 Versiones del tfstate y restauración

**Frase:** «El bucket tiene versioning. Cada apply deja una versión nueva y puedo volver a cualquiera sin perder ninguna.»

```powershell
.\scripts\infra\restore-state.ps1 -Environment dev          # tabla de VersionId / fecha / IsLatest
```

- Además, en la Floci UI: S3 → `aegisvolt-tfstate` → `env:/dev/...` → Versions.
- Si piden restaurar en vivo, usa la versión **más reciente**. Así es inocuo y deja una versión nueva idéntica:
  ```powershell
  .\scripts\infra\restore-state.ps1 -Environment dev -VersionId <VersionId de IsLatest=True>
  cd infra\terraform; terraform plan "-var-file=environments/dev.tfvars"; cd ..\..     # "No changes"
  ```

**Explicar:** el script descarga la versión, valida el `lineage` y hace `terraform state push -force`. La versión corrupta queda en el historial.

### 2.3 Recorrido del paquete por VPC Endpoints

**Frase:** «Un workload de la VPC resuelve `execute-api` por DNS privado hacia la ENI del **Interface VPC Endpoint**, en una subred privada. El security group del endpoint solo acepta 443 desde la VPC, y la API privada solo acepta llamadas cuyo `aws:SourceVpce` sea ese endpoint. De ahí, API Gateway entrega por el VPC Link al NLB interno, que llega al NodePort del nodo y al pod. La tabla de rutas privada solo tiene la ruta local: el paquete nunca sale a Internet.»

**Segunda frase:** «El navegador entra por la HTTP API pública y comparte el tramo final: VPC Link, NLB, NodePort, pod. Los pods salen a DynamoDB y S3 por Gateway VPCE, y a CloudWatch por Interface VPCE.»

```powershell
# 1. El VPC Endpoint de execute-api y la policy de la API privada (aws:SourceVpce)
aws ec2 describe-vpc-endpoints --filters Name=tag:Name,Values=aegisvolt-dev-vpce-execute-api --query "VpcEndpoints[0].[VpcEndpointId,VpcEndpointType,PrivateDnsEnabled]" --output table
$priv = aws apigateway get-rest-apis --query "items[?name=='aegisvolt-dev-internal'].id | [0]" --output text
aws apigateway get-rest-api --rest-api-id $priv --query "{tipo:endpointConfiguration.types,vpce:endpointConfiguration.vpcEndpointIds,policy:policy}"
# 2. Tabla de rutas privada, resto de endpoints y targets del NLB
aws ec2 describe-route-tables --filters Name=tag:Name,Values=aegisvolt-dev-rt-private --query "RouteTables[0].Routes" --output table
aws ec2 describe-vpc-endpoints --filters Name=tag:Name,Values=aegisvolt-dev-* --query "VpcEndpoints[].[ServiceName,VpcEndpointType,PrivateDnsEnabled]" --output table
aws ec2 describe-vpc-endpoints --filters Name=tag:Name,Values=aegisvolt-dev-vpce-dynamodb --query "VpcEndpoints[0].PolicyDocument" --output text
$tg = aws elbv2 describe-target-groups --names aegisvolt-dev-tg-graphql --query "TargetGroups[0].TargetGroupArn" --output text
aws elbv2 describe-target-health --target-group-arn $tg --output table      # IP del nodo : 30080 healthy
```

**Código a señalar:** [modules/network/main.tf](../infra/terraform/modules/network/main.tf) (rt-private sin 0.0.0.0/0 y policies) y [modules/api-gateway/main.tf](../infra/terraform/modules/api-gateway/main.tf) (cadena de security groups y API privada con `aws:SourceVpce`).

> **Si preguntan por la ruta prefix-list:** Floci guarda la asociación del Gateway VPCE con `rt-private` pero no la muestra en `describe-route-tables`. En AWS real aparece como `pl-xxxx → vpce-xxxx`.
>
> **Si piden probar que desde fuera no entra:** dilo sin rodeos: «Floci no evalúa resource policies, así que aquí la API privada responde. Lo que sí puedo mostrar es la policy declarada y que Prefect la usa: en el bloque 5.2 el log dice *recuperada via API private*.»
>
> **Si preguntan por el API server de EKS:** «Tiene acceso público y privado para que el runner lo alcance; los nodos y los pods están en subredes privadas. En producción restringiría `public_access_cidrs`.»

---

## 3. CI/CD, gobernanza y canary (25%)

### 3.1 Push directo y force push bloqueados

**Frase:** «`dev`, `test` y `prod` están protegidas por un ruleset sin bypass, ni siquiera para mí.»

```powershell
git switch test; git pull -q
git commit --allow-empty -m "intento directo"
git push origin test             # GH013: Changes must be made through a pull request
# Force push REAL: reescribir historia (si el commit solo avanza, no es non-fast-forward)
git reset --hard HEAD~1; git commit --allow-empty -m "historia reescrita"
git push --force origin test     # GH013: Cannot force-push to this branch
git reset --hard origin/test; git switch dev
```

**Mostrar:** la pestaña Rulesets, con `non_fast_forward`, `pull_request` (solo merge), los 6 checks y bypass vacío. El JSON versionado está en [protected-env-branches.json](../.github/rulesets/protected-env-branches.json).

### 3.2 Cómo el YAML elige el ambiente

**Mostrar:** [cd.yml](../.github/workflows/cd.yml). `on: push` a las ramas de ambiente solo ocurre por un merge. `resolve-env` lee `github.ref_name` y lo pasa a `terraform.ps1`, que ejecuta `workspace select` y `apply -auto-approve`.

**En GitHub:** abrir el run de CD del merge `test → prod` (PR #8):
- El *Job Summary* de `terraform-apply` muestra `Workspace activo: prod`.
- `k8s-apply` muestra las imágenes.
- `canary-deploy` muestra la tabla del gate.

### 3.3 Canary: promoción y rollback automático

**Frase:** «Cada servicio tiene un Deployment stable de 4 réplicas y uno canary. Con 1 canary de 5 pods, el canary recibe el 20% del tráfico. El gate lee en CloudWatch la tasa de error del `Track=canary` y la alarma; si falla, hace rollback automático.»

```powershell
# Terminal 2: ver los pods durante el canary
kubectl --kubeconfig $KDEV -n aegisvolt get pods -L aegisvolt.io/track -w

# Terminal 1: canary con 60% de errores inyectados SOLO en el canary
.\scripts\ci\canary-deploy.ps1 -Environment dev -Service billing-wallet-service -Version demo -Force -InjectErrorRate 0.6 -Requests 100
#  Trafico sintetico (100 requests): {"ok":..,"fail":..,"canary":~20}
#  ### Canary ... ROLLBACK automatico   | Tasa de error canary <= 5% | FALLA |
```

Variante sana, solo si piden ver una promoción:
```powershell
.\scripts\ci\canary-deploy.ps1 -Environment dev -Service billing-wallet-service -Version demo-ok -Force -Requests 100   # PROMOVIDO a 100%
```

Antes de repetir un canary después de un rollback, confirma que la alarma volvió a `OK`:
```powershell
aws cloudwatch describe-alarms --alarm-names aegisvolt-dev-billing-wallet-service-canary-errors --query "MetricAlarms[0].StateValue" --output text
```

> **Si muestran un run de CD con «sin cambios»:** es correcto. El tag de la imagen es el hash del contenido del servicio; si no cambió, no hay nada que promover. Por eso la demo usa `-Force`.
>
> **Plan B:** si el canary tarda, las promociones reales están en el run de CD del PR #6 (dev): `frontend`, `station` y `billing` salieron PROMOVIDOS con 0% de error.

---

## 4. Backend, GraphQL, SAGA y feature flags (25%)

### 4.1 Falla inducida en **test** y compensación en DynamoDB (pregunta guía)

**Frase:** «Activo la falla de hardware solo en test, disparo la reserva por GraphQL y muestro la compensación en las tablas de billing y reservas.»

1. En la **UI de test**, panel de servicio: girar **Simular falla de hardware** a ON. La lámpara TEST se enciende y PROD sigue en off.
   - **Cuenta 4 segundos** antes del paso siguiente. Los pods de `energy-dispatch-service` leen la flag con cache de 3 s; si disparas antes, la SAGA puede salir completada.
2. En la **UI de test**: flota *Logística Andina Express*, 20 kWh, **AUTORIZAR Y CARGAR**.
   - Sale un ticket **en negativo** con el sello **REVERSO**: «El cargador reportó una falla física», luego «Reembolso a la billetera · reembolsado» y «Liberación de la bahía · liberada».
   - Copia el `correlation_id` del pie del ticket.
3. Evidencia en DynamoDB:
   ```powershell
   $SAGA = "<sagaId del ticket>"
   aws dynamodb query --table-name aegisvolt-billing-test --key-condition-expression "pk = :p AND begins_with(sk, :t)" `
     --expression-attribute-values "{\":p\":{\"S\":\"WALLET#fleet-andina\"},\":t\":{\"S\":\"TXN#$SAGA\"}}" `
     --query "Items[].{sk:sk.S,tipo:type.S,monto:amountCents.N}" --output table          # CHARGE + REFUND
   aws dynamodb get-item --table-name aegisvolt-reservations-test `
     --key "{\"pk\":{\"S\":\"RESERVATION#$SAGA\"},\"sk\":{\"S\":\"META\"}}" --query "Item.{estado:status.S,conector:connectorId.S}"   # RELEASED
   aws dynamodb get-item --table-name aegisvolt-saga-test `
     --key "{\"pk\":{\"S\":\"SAGA#$SAGA\"},\"sk\":{\"S\":\"META\"}}" --query "Item.{estado:status.S,compensaciones:compensations}"
   ```
4. **Apagar** la llave en la UI de test.

**Explicar:** se compensa en orden inverso. Primero el reembolso, después la liberación, para que nunca quede la bahía libre con el saldo todavía retenido.

### 4.2 Idempotencia: compensación duplicada

```powershell
kubectl --kubeconfig "$HOME\.kube\aegisvolt-test.yaml" -n aegisvolt exec deploy/graphql-gateway -- node -e "fetch('http://billing-wallet-service:8080/charges/$SAGA/refund',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fleetId:'fleet-andina'})}).then(r=>r.json()).then(console.log)"
#  { outcome: 'ALREADY_REFUNDED', alreadyRefunded: true }   -> el saldo NO cambia
```

**Frase:** «El `sagaId` es la clave de idempotencia. `attribute_not_exists` dentro de un `TransactWriteItems` hace que el segundo reembolso no sume saldo.» Código: [billing/repository.ts](../services/billing-wallet-service/src/repository.ts) → `refund()`.

### 4.3 Esquema GraphQL

- Abrir `$DEV/graphql` en el navegador: GraphiQL está habilitado en dev y test, y deshabilitado en prod.
- Mostrar Queries y Mutations y ejecutar `{ transactions(limit: 3) { sagaId status compensations { step outcome } } }`.
- Código: [schema.graphql](../graphql-gateway/src/schema.graphql).

---

## 5. Observabilidad (12%)

### 5.1 Prefect + `correlation_id` en CloudWatch (pregunta guía)

```powershell
docker exec aegisvolt-prefect-prefect-observer-1 prefect deployment run "aegisvolt-observability/on-demand"
```

- En Prefect (pestaña 4) abrir el run: subflows `environment-health` y `saga-consistency-audit`, sus tasks por ambiente y los artifacts. Los artifacts son la tabla de salud, la matriz de flags × ambiente y la auditoría de SAGAs.
- Rastrear la SAGA fallida del bloque 4.1 en CloudWatch:
  ```powershell
  .\scripts\demo\trace-saga.ps1 -Environment test -SagaId $SAGA
  ```
  Muestra la línea de tiempo de los 4 servicios: `charger_fault` → `wallet_refund` → `reservation_released` → `saga_compensated`.

### 5.2 Extra: SAGA huérfana compensada por Prefect

```powershell
.\scripts\demo\create-orphan-saga.ps1 -Environment dev
docker exec aegisvolt-prefect-prefect-observer-1 prefect deployment run "saga-consistency-audit/every-5-minutes"
docker logs aegisvolt-prefect-prefect-observer-1 --tail 30 | Select-String "huerfana|Auditoria dev"
#  SAGA huerfana saga-orphan-xxxx (dev) recuperada via API private -> COMPENSATED
```

---

## 6. Frontend (8%)

### 6.1 Flag en dev sin redesplegar, prod intacto (pregunta guía)

1. Poner lado a lado la **UI dev** (placa amarilla) y la **UI prod** (placa roja, panel con candado).
2. En dev, girar **Ultra-carga prioritaria** a OFF. En ≤ 3 s, el interruptor «Ultra-carga prioritaria 350 kW» del teclado se **bloquea**. En el tablero de lámparas, DEV pasa a off y **PROD no cambia**.
3. Girarla de nuevo a ON. Activar el interruptor de ultra-carga y autorizar: el ticket sale completado en la manguera **C3 · ULTRA**.
4. En prod, la llave está bloqueada y la UI dice «Panel bloqueado en producción».

**Frase:** «La flag vive en `aegisvolt-feature-flags-dev`, no en el código ni en el ConfigMap. Los pods la leen con cache de 3 s. No hubo rollout, la imagen es la misma.»

### 6.2 Si piden "tiempo real"

En la UI dev autorizar 60 kWh: el LCD muestra kW, kWh, batería, tensión y temperatura en vivo, la manguera pasa a **CARGANDO** y al terminar vuelve a **LIBRE**.

---

## 7. Al cerrar: dejar todo limpio

```powershell
foreach ($e in 'dev','test') {
  aws dynamodb update-item --table-name "aegisvolt-feature-flags-$e" --key '{\"flag\":{\"S\":\"SIMULATE_CHARGER_HARDWARE_FAULT\"}}' `
    --update-expression "SET enabled = :f" --expression-attribute-values '{\":f\":{\"BOOL\":false}}'
}
Gql $DEV 'mutation { topUpWallet(fleetId:"fleet-andina", amountCents:20000) { balanceCents } }'   # recargar saldo si se gastó
kubectl --kubeconfig $KDEV -n aegisvolt scale deploy/billing-wallet-service-canary --replicas=0
```

---

## Plan B

| Si pasa esto… | Hacer |
|---------------|-------|
| GitHub Actions caído (ya pasó el 9-nov) | Mostrar runs anteriores en verde (PR #6 a #8) y [githubstatus.com](https://www.githubstatus.com). Todo lo demás es local y sigue funcionando |
| Floci se reinició | Los datos persisten (modo `persistent`). `Get-Kubeconfig` usa sola la credencial del k3s si el token IAM falla. Correr `preflight.ps1 -Fix` |
| Pods en `CrashLoopBackOff` con `ECONNREFUSED <ClusterIP>:4566` o canary con `ErrImagePull` tras reiniciar Docker | Otro contenedor (p. ej. Prefect) tomó la IP que los k3s esperan para Floci. `preflight.ps1 -Fix` lo detecta (chequeo «IP de Floci = mirrors de los k3s») y devuelve Floci a esa IP |
| El registry de ECR no responde tras recrear Floci | `docker network connect aegisvolt floci-aws-ecr-registry` |
| La UI no carga en el navegador integrado de la app | Usar Chrome/Edge normal; el integrado bloquea los assets de `*.localhost.floci.io` |
| Las URLs de las UI cambiaron | Las imprime `preflight.ps1`. También `aws apigatewayv2 get-apis` |
| Una SAGA queda con la bahía bloqueada | `create-orphan-saga` y la auditoría la compensan; si no, el lock vence solo (TTL `lockExpiresAt`) |
| El runner no toma jobs | `C:\actions-runner-aegisvolt\run.cmd` en una terminal |
| Docker pide memoria | Cerrar `parcial2`/otros contenedores; los 3 clústeres k3s usan ~3 GB |

## Respuestas de una línea (para preguntas rápidas)

| Pregunta | Respuesta |
|----------|-----------|
| ¿Por qué orquestación y no coreografía? | Orden estricto y compensación en orden inverso explícitos y auditables en un log persistente |
| ¿Y si un paso falla por timeout pero sí se aplicó? | El motor trata timeout y 5xx como fallo ambiguo y compensa también ese paso; la compensación es idempotente y responde `NOTHING_TO_*` si no había nada |
| ¿Qué es el pivot? | Activar el cargador: si falla se compensa todo, si pasa ya no se revierte; después solo hay pasos que se reintentan |
| ¿Por qué solo merge commit? | Para que `dev`, `test` y `prod` compartan los mismos commits; un squash haría divergir las ramas |
| ¿Cómo sabe el canary qué desplegar? | El tag de imagen es el hash del contenido del servicio; si es igual al stable, el resultado es "sin cambios" |
| ¿Cómo llega el pod a AWS sin Internet? | En AWS real, por los VPC Endpoints. En Floci, por el Service `floci` sin selector con una EndpointSlice |
| ¿Por qué Floci en modo persistent? | En modo memoria, un reinicio borra el bucket del tfstate y todas sus versiones |
