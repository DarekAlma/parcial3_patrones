# Documentación AegisVolt — índice

## Guías de sustentación (por capa de la rúbrica)

| Capa | Peso | Documento | Preguntas guía del enunciado |
|------|------|-----------|------------------------------|
| 1. IaC, S3, Redes, DynamoDB | 30% | [sustentacion/01-infraestructura-iac.md](sustentacion/01-infraestructura-iac.md) | 6.1 (aislamiento test/prod, versiones del tfstate, recorrido de red por VPCE) |
| 2. CI/CD, Git, Canary | 25% | [sustentacion/02-cicd-gobernanza.md](sustentacion/02-cicd-gobernanza.md) | 6.2 (push bloqueado, apply dinámico, métrica del canary) |
| 3. Backend, GraphQL, SAGA, Flags | 25% | `sustentacion/03-backend-saga.md` *(fase de servicios)* | 6.3 (compensación en DynamoDB, idempotencia) |
| 4. Observabilidad | 12% | `sustentacion/05-observabilidad-frontend.md` *(fase Prefect)* | 6.4 (Prefect + correlation_id en CloudWatch) |
| 5. Frontend | 8% | `sustentacion/05-observabilidad-frontend.md` *(fase frontend)* | 6.4 (flag en dev sin redesplegar) |

## Referencia

| Documento | Contenido |
|-----------|-----------|
| [GOBERNANZA-GIT.md](GOBERNANZA-GIT.md) | Ramas, promoción, ruleset, pipelines, runner |
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
