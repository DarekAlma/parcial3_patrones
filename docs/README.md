# Documentación AegisVolt — índice

## Guías de sustentación (por capa de la rúbrica)

| Capa | Peso | Documento | Preguntas guía del enunciado |
|------|------|-----------|------------------------------|
| 1. IaC, S3, Redes, DynamoDB | 30% | [sustentacion/01-infraestructura-iac.md](sustentacion/01-infraestructura-iac.md) | 6.1 (aislamiento test/prod, versiones del tfstate, recorrido de red por VPCE) |
| 2. CI/CD, Git, Canary | 25% | [sustentacion/02-cicd-gobernanza.md](sustentacion/02-cicd-gobernanza.md) + [04-kubernetes-canary.md](sustentacion/04-kubernetes-canary.md) | 6.2 (push bloqueado, apply dinámico, métrica del canary) |
| 3. Backend, GraphQL, SAGA, Flags | 25% | [sustentacion/03-backend-saga.md](sustentacion/03-backend-saga.md) | 6.3 (compensación en DynamoDB, idempotencia) |
| 4. Observabilidad | 12% | `sustentacion/05-observabilidad-frontend.md` *(fase Prefect)* | 6.4 (Prefect + correlation_id en CloudWatch) |
| 5. Frontend | 8% | `sustentacion/05-observabilidad-frontend.md` *(fase frontend)* | 6.4 (flag en dev sin redesplegar) |

## Referencia

| Documento | Contenido |
|-----------|-----------|
| [GOBERNANZA-GIT.md](GOBERNANZA-GIT.md) | Ramas, promoción, ruleset, pipelines, runner |
| [sustentacion/04-kubernetes-canary.md](sustentacion/04-kubernetes-canary.md) | Kubernetes, canary 20/80, gate de CloudWatch, rollback |
| [sustentacion/01-infraestructura-iac.md](sustentacion/01-infraestructura-iac.md) | Estructura Terraform, workspaces, backend, red, tablas |

## Dónde están las cosas importantes

| Necesito mostrar… | Archivo |
|-------------------|---------|
| Que el estado vive en S3 versionado | [infra/bootstrap/main.tf](../infra/bootstrap/main.tf), [infra/terraform/versions.tf](../infra/terraform/versions.tf) |
| Que los nombres usan `${terraform.workspace}` | [infra/terraform/locals.tf](../infra/terraform/locals.tf) |
| La VPC, subredes y VPCE | [infra/terraform/modules/network/main.tf](../infra/terraform/modules/network/main.tf) |
| API Gateway → VPC Link → NLB → EKS | [infra/terraform/modules/api-gateway/main.tf](../infra/terraform/modules/api-gateway/main.tf) |
| Tablas DynamoDB por servicio y ambiente | [infra/terraform/locals.tf](../infra/terraform/locals.tf) (`tables`), [modules/dynamodb](../infra/terraform/modules/dynamodb/main.tf) |
| Flags por ambiente | [infra/terraform/environments/*.tfvars](../infra/terraform/environments/), [modules/feature-flags](../infra/terraform/modules/feature-flags/main.tf) |
| Log groups `/aegisvolt/<env>/...` y alarmas | [infra/terraform/modules/observability/main.tf](../infra/terraform/modules/observability/main.tf) |
| Selección dinámica del workspace en CI/CD | [.github/workflows/cd.yml](../.github/workflows/cd.yml), [scripts/ci/terraform.ps1](../scripts/ci/terraform.ps1) |
| Reglas de protección de ramas | [.github/rulesets/protected-env-branches.json](../.github/rulesets/protected-env-branches.json) |
| Restaurar una versión del tfstate | [scripts/infra/restore-state.ps1](../scripts/infra/restore-state.ps1) |

## Puesta en marcha local (orden)

```powershell
# 1. Floci persistente (emulador AWS)
docker compose -f infra/floci/docker-compose.yml up -d
# 2. Backend de Terraform (bucket S3 versionado)
.\scripts\infra\bootstrap.ps1
# 3. Infraestructura de cada ambiente (lo hace el CD en cada merge; manual para pruebas)
.\scripts\ci\terraform.ps1 -Action apply -Environment dev
# 4. Runner de GitHub Actions
C:\actions-runner-aegisvolt\run.cmd
```

## Backend (capa 3)

| Necesito mostrar… | Archivo |
|-------------------|---------|
| El esquema GraphQL (Queries / Mutations) | [graphql-gateway/src/schema.graphql](../graphql-gateway/src/schema.graphql) |
| El motor SAGA y el orden inverso de compensación | [graphql-gateway/src/saga/engine.ts](../graphql-gateway/src/saga/engine.ts) |
| Los pasos de la SAGA y sus compensaciones | [graphql-gateway/src/saga/reserve-charge-saga.ts](../graphql-gateway/src/saga/reserve-charge-saga.ts) |
| Idempotencia del reembolso (`attribute_not_exists`) | [services/billing-wallet-service/src/repository.ts](../services/billing-wallet-service/src/repository.ts) |
| Bloqueo temporal de bahías y liberación | [services/station-reservation-service/src/repository.ts](../services/station-reservation-service/src/repository.ts) |
| Inyección de fallo de hardware | [services/energy-dispatch-service/src/app.ts](../services/energy-dispatch-service/src/app.ts) |
| Lectura de flags con cache | [packages/common/src/flags.ts](../packages/common/src/flags.ts) |

```powershell
npm ci
npm run test:unit          # 28 pruebas, sin red
npm run test:integration   # 25 pruebas, DynamoDB en Floci (tablas efimeras)
npm run test:e2e           # 7 pruebas, 4 servicios como procesos + GraphQL
npm run dev:stack          # servicios locales contra las tablas de dev -> http://localhost:8080/graphql
```
