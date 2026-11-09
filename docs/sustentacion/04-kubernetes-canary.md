# Kubernetes y Canary Deployment (parte de la capa 2, 25%)

## Mapa rápido

| Qué | Dónde |
|-----|-------|
| Manifiestos base (stable + canary + Service) | [k8s/base/](../../k8s/base/) |
| Configuración por ambiente (ConfigMap) | [k8s/overlays/{dev,test,prod}/kustomization.yaml](../../k8s/overlays/) |
| Namespace, Service `floci`, NetworkPolicy | [k8s/base/platform.yaml](../../k8s/base/platform.yaml) |
| Deploy del ambiente (ECR, apply, NLB targets) | [scripts/k8s/deploy.ps1](../../scripts/k8s/deploy.ps1) |
| **Canary: gate de CloudWatch, promoción y rollback** | [scripts/ci/canary-deploy.ps1](../../scripts/ci/canary-deploy.ps1) |
| Helpers (kubeconfig, tag de imagen, ECR) | [scripts/k8s/k8s.ps1](../../scripts/k8s/k8s.ps1) |
| Metric filters y alarma del canary | [infra/terraform/modules/observability/main.tf](../../infra/terraform/modules/observability/main.tf) |
| Repos ECR por ambiente | [infra/terraform/modules/ecr/main.tf](../../infra/terraform/modules/ecr/main.tf) |
| Jobs `k8s-apply` y `canary-deploy` | [.github/workflows/cd.yml](../../.github/workflows/cd.yml) |

## Pipeline post-merge completo

```
merge a dev|test|prod
  └─ resolve-env ─► terraform-apply ─► k8s-apply ─► canary-deploy (x4 servicios, uno a la vez)
                     (workspace env)    │              │
                                        │              ├─ imagen nueva == stable ? => "sin cambios"
                                        │              ├─ <svc>-canary: imagen nueva, 1 réplica (20%)
                                        │              ├─ tráfico sintético + espera de métricas
                                        │              ├─ gate CloudWatch (4 condiciones)
                                        │              └─ OK: stable := nueva (rolling) | NOK: rollback
                                        ├─ build + push a ECR (solo si el tag no existe)
                                        ├─ kubectl apply (conserva la imagen stable actual)
                                        └─ registra IP del nodo : 30080 en el target group del NLB
```

## Cómo se logra el 20/80 en Kubernetes

Cada servicio tiene **dos Deployments** con el mismo label `app.kubernetes.io/name` y un **Service que selecciona solo por ese label**:

| Deployment | Labels | Réplicas en reposo | Réplicas durante el canary |
|------------|--------|--------------------|---------------------------|
| `<svc>` (stable) | `track: stable` | 4 | 4 |
| `<svc>-canary` | `track: canary` | 0 | **1** |

kube-proxy reparte las **conexiones** entre todos los pods listos del Service. Con 1 pod canary de 5 en total, el canary recibe **~20%** del tráfico.

Lo verificamos: con 100 requests en conexiones independientes, **20 fueron al canary** (cada pod responde con el header `x-aegis-track`, así se cuenta quién atendió).

> El balanceo es **por conexión TCP**. Un cliente con keep-alive se queda con un solo pod. Por eso la sonda del canary abre una conexión nueva por request (`agent:false`), igual que muchos clientes distintos. Con un service mesh (Istio, Linkerd) o un Ingress con `canary-weight` se podría repartir **por request** con pesos exactos. Aquí se eligió Kubernetes nativo para no agregar componentes.

---

## Pregunta guía

### ¿Qué métrica o condición evalúa su etapa de Canary Deployment antes de promover el tráfico del 20% al 100% en Kubernetes?

**Respuesta corta:** la **tasa de error del canary en CloudWatch**, calculada como `ErrorCount / RequestCount` con dimensión `Track=canary` en el namespace `AegisVolt/<env>`. Debe ser **≤ 5%**, con al menos **5 requests** atendidas por el canary. Además, la alarma `aegisvolt-<env>-<svc>-canary-errors` no puede estar en `ALARM` y el canary debe estar `Ready` y sin reinicios. Si las cuatro condiciones se cumplen, se promueve. Si falla cualquiera, hay **rollback automático**.

**Las 4 condiciones del gate** (`scripts/ci/canary-deploy.ps1`):

| # | Condición | Fuente | Por qué |
|---|-----------|--------|---------|
| a | Canary `Ready` y `restartCount = 0` | Kubernetes (readiness `/ready`, que consulta DynamoDB) | Un pod que no arranca o que reinicia (crash loop) no puede recibir más tráfico |
| b | `RequestCount(Service, Track=canary) ≥ 5` | CloudWatch | **Evita falsos positivos**: si el canary no recibió tráfico, "0 errores" no prueba nada |
| c | `ErrorCount / RequestCount ≤ 5%` | CloudWatch | Es la señal principal: respuestas 5xx o errores no controlados de la versión nueva |
| d | Alarma `...-canary-errors` ≠ `ALARM` | CloudWatch Alarms | Umbral absoluto: ≥1 error/min del canary dispara la alarma |

**De dónde salen las métricas:**
1. Cada pod escribe logs JSON a `/aegisvolt/<env>/<svc>` con `service` y `track` (`stable` o `canary`, desde la env `TRACK` del Deployment).
2. Cada request genera `event=http_request`. Las respuestas 5xx se loguean con `level=ERROR`.
3. Los **metric filters** de Terraform convierten esos logs en `RequestCount` y `ErrorCount` con dimensiones `Service` y `Track`.
4. El gate consulta `GetMetricStatistics` **desde que empezó el canary**, para no mezclarlo con canaries anteriores.

```powershell
aws cloudwatch get-metric-statistics --namespace AegisVolt/dev --metric-name ErrorCount `
  --dimensions Name=Service,Value=billing-wallet-service Name=Track,Value=canary `
  --start-time 2026-11-09T18:00:00Z --end-time 2026-11-09T19:00:00Z --period 60 --statistics Sum
```

**Resultados reales (dev):**

| Escenario | Tráfico al canary | RequestCount | ErrorCount | Tasa | Alarma | Decisión |
|-----------|-------------------|--------------|------------|------|--------|----------|
| Versión sana | 20 de 100 | 20 | 0 | 0% | OK | **PROMOVIDO a 100%** |
| `INJECT_ERROR_RATE=0.6` | 25 de 100 | 25 | 14 | 56% | ALARM | **ROLLBACK automático** |

**Promoción:** `kubectl set image deployment/<svc> app=<nueva>`. Esto hace un rolling update del stable (`maxSurge: 1`, `maxUnavailable: 0`, sin downtime). Cuando termina, el canary vuelve a 0 réplicas.

**Rollback:** el canary vuelve a 0 réplicas y se borra la variable de inyección. El stable **nunca se tocó**, así que el 80% del tráfico siempre estuvo en la versión buena. El job falla y queda en rojo en GitHub con la tabla de métricas en el *Job Summary*.

### Demostración en vivo del rollback

```powershell
# Fuerza un canary de billing con 60% de errores 5xx inyectados SOLO en el canary
.\scripts\ci\canary-deploy.ps1 -Environment dev -Service billing-wallet-service -Version demo -Force -InjectErrorRate 0.6 -Requests 100
#  Trafico sintetico (100 requests): {"ok":86,"fail":14,"canary":25}
#  ### Canary `billing-wallet-service` en `dev`: ROLLBACK automatico
#  | Tasa de error canary <= 5% | FALLA |

# Mientras corre, en otra terminal: 4 pods stable + 1 canary
kubectl --kubeconfig $HOME\.kube\aegisvolt-dev.yaml -n aegisvolt get pods -L aegisvolt.io/track
```

---

## Otras preguntas probables

**¿Qué pasa si un servicio no cambió en el merge?** El tag de imagen es un **hash del contenido** del servicio (su carpeta, `packages/common`, el Dockerfile y el lockfile). Si coincide con el stable, el job dice "sin cambios" y no crea canary. Así solo se despliega progresivamente lo que realmente cambió.

**¿Cómo se garantiza que dev, test y prod corren la misma imagen?**
- La imagen no contiene nada del ambiente: `AEGIS_ENV`, las URLs y `FLAG_ADMIN_ENABLED` vienen del ConfigMap del overlay.
- El mismo código produce **el mismo tag** en los tres ambientes, y los repos ECR son `IMMUTABLE` (un tag nunca se sobrescribe).

**¿Por qué `k8s-apply` no despliega la versión nueva directamente?** Porque eso saltaría el canary. `deploy.ps1` renderiza los manifiestos **conservando la imagen stable actual**, y la versión nueva solo entra por `canary-deploy`. La excepción es el **primer** despliegue: como no hay stable, se instala la versión nueva.

**¿Cómo llega el tráfico del NLB al pod?** El NLB tiene un target group `target_type = ip` en el puerto **30080**, que es el NodePort del Service `graphql-gateway`. `deploy.ps1` registra la IP interna de cada nodo (`kubectl get nodes` → `InternalIP`), igual que haría el AWS Load Balancer Controller con un `TargetGroupBinding`. El health check del target group es HTTP `GET /health`.

**¿Cómo hablan los pods con DynamoDB y CloudWatch sin salir a Internet?**
- **En AWS real:** el SDK usa `dynamodb.us-east-1.amazonaws.com`, que la VPC enruta por el **Gateway VPCE**, y `logs.us-east-1.amazonaws.com`, que el DNS privado resuelve al **Interface VPCE**.
- **Con Floci:** el equivalente es el Service `floci` (sin selector) con una `EndpointSlice` a la IP de Floci en la red Docker, y los pods usan `AWS_ENDPOINT_URL=http://floci.aegisvolt.svc.cluster.local:4566`.
- Lo comprobamos así: sin esa configuración, un pod que resuelve `dynamodb.us-east-1.amazonaws.com` llega a la **AWS real** (IP `3.218.x`). Por eso el endpoint se fija explícitamente.

**¿Qué seguridad tienen los pods?**
- Namespace con Pod Security `restricted`: `runAsNonRoot`, `seccompProfile: RuntimeDefault`, `readOnlyRootFilesystem`, `capabilities: drop ALL`, sin escalada de privilegios.
- `requests`/`limits` de CPU y memoria.
- NetworkPolicy: los 3 servicios de backend solo aceptan tráfico del gateway, y station además de dispatch.
- Cada ServiceAccount está asociada a su rol IAM por Pod Identity.

**¿Cómo se conecta el pipeline al clúster?** Con `aws eks update-kubeconfig`, que usa un token IAM por `aws eks get-token`. En Floci, el webhook de autenticación del k3s deja de validar tokens después de un reinicio de Floci. En ese caso `Get-Kubeconfig` usa el kubeconfig de administrador del propio k3s, apuntando al endpoint que publica EKS (`describe-cluster`). En AWS real solo existe el primer camino.

**¿Cómo funciona el registro de imágenes?** Las imágenes se suben a ECR de Floci (`localhost:4566/000000000000/us-east-1/aegisvolt-<env>/<svc>`, estilo *path*, porque Docker Desktop con containerd solo permite HTTP plano hacia `localhost`). Floci configura en cada k3s un *registry mirror* hacia ese registro, así el pull funciona sin credenciales extra.
