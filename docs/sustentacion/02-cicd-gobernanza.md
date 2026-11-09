# Capa 2 — CI/CD, Gobernanza de Git, Ambientes y Canary (25%)

> Complementa [docs/GOBERNANZA-GIT.md](../GOBERNANZA-GIT.md). Aquí están las respuestas para la defensa.

## Mapa rápido

| Qué | Dónde |
|-----|-------|
| Pipeline pre-merge (PR) | [.github/workflows/ci.yml](../../.github/workflows/ci.yml) |
| Pipeline post-merge (deploy) | [.github/workflows/cd.yml](../../.github/workflows/cd.yml) |
| Reglas de protección (ruleset) | [.github/rulesets/protected-env-branches.json](../../.github/rulesets/protected-env-branches.json) |
| Aplicar ruleset, ramas y environments | [scripts/github/setup-repo.ps1](../../scripts/github/setup-repo.ps1) |
| Runner self-hosted | [scripts/github/setup-runner.ps1](../../scripts/github/setup-runner.ps1) |
| plan/apply por workspace | [scripts/ci/terraform.ps1](../../scripts/ci/terraform.ps1) |
| Canary | [scripts/ci/canary-deploy.ps1](../../scripts/ci/canary-deploy.ps1) |
| Repo | https://github.com/DarekAlma/parcial3_patrones |

## Arquitectura del pipeline

```
 PR feature/* ─► dev        PR dev ─► test        PR test ─► prod
        │                        │                       │
        ▼  ci.yml (pull_request, base_ref = rama destino)
 promotion-guard ─► lint-build ─► unit-tests ─► integration-tests ─► e2e-tests
        └──────────► terraform-plan (workspace = base_ref)
        │
        ▼  (6 checks verdes => boton Merge habilitado; solo "merge commit")
 merge ─► push a dev|test|prod
        │
        ▼  cd.yml (push, ref_name = rama que recibio el merge)
 resolve-env ─► terraform-apply (workspace select <env>; apply -auto-approve)
             ─► canary-deploy x4 servicios (20% ─► health/CloudWatch ─► 100% | rollback)
```

**¿Dónde corre?** GitHub Actions orquesta todo: eventos, orden de jobs, checks, logs, artefactos y environments. Los jobs se ejecutan en un **runner self-hosted** (`runs-on: [self-hosted, aegisvolt]`) en el PC donde corre Floci (`localhost:4566`). Los runners en la nube de GitHub no pueden llegar a ese endpoint.

---

## Pregunta guía 1

### Intente hacer un `git push --force` o un push directo a la rama `test` desde su terminal y muestre qué regla del repositorio lo bloquea.

**Respuesta corta:** lo bloquea el **ruleset `protected-env-branches`**, activo sobre `dev`, `test` y `prod` y **sin bypass para nadie**, ni el administrador. La regla `pull_request` rechaza todo push directo. La regla `non_fast_forward` rechaza el force push.

**Demostración:**
```powershell
git switch test
git pull
git commit --allow-empty -m "intento de push directo"
git push origin test
#  remote: error: GH013: Repository rule violations found for refs/heads/test.
#  remote: - Changes must be made through a pull request.
#   ! [remote rejected] test -> test (push declined due to repository rule violations)

git push --force origin test
#  remote: error: GH013: Repository rule violations found for refs/heads/test.
#   ! [remote rejected] test -> test (push declined due to repository rule violations)

git reset --hard origin/test   # deshacer el commit local
git switch dev
```

**Dónde se ve la regla:** GitHub → *Settings → Rules → Rulesets → protected-env-branches*, o en el JSON versionado [protected-env-branches.json](../../.github/rulesets/protected-env-branches.json):

| Regla | Qué bloquea |
|-------|-------------|
| `non_fast_forward` | `git push --force` (reescribir historia) |
| `pull_request` (`allowed_merge_methods: ["merge"]`) | Push directo; solo entra código por PR, y solo como merge commit |
| `required_status_checks` | Merge mientras no estén verdes `promotion-guard`, `lint-build`, `unit-tests`, `integration-tests`, `e2e-tests` y `terraform-plan` |
| `deletion` | Borrar `dev`, `test` o `prod` |
| `bypass_actors: []` | Nadie puede saltarse las reglas, ni el dueño del repo |

**Detalles que suman puntos:**
- Los checks requeridos están atados a `integration_id: 15368` (la app GitHub Actions). Nadie puede marcarlos en verde a mano con la API de *commit statuses*.
- El ruleset está **versionado en el repo** y se aplica con `setup-repo.ps1`: la gobernanza también es código (*policy as code*).
- **Rulesets vs. branch protection clásica:** los rulesets permiten un solo conjunto de reglas para varias ramas, se pueden exportar e importar como JSON y se pueden poner en modo *evaluate*.

---

## Pregunta guía 2

### Explique en el archivo YAML de su pipeline cómo se determina dinámicamente sobre qué ambiente correr `terraform apply` tras fusionar un Merge Request.

**Respuesta corta:**
1. `cd.yml` se dispara con `on: push` a `dev`, `test` o `prod`. Como esas ramas no aceptan push directo, ese evento **solo puede venir de un PR fusionado**.
2. El job `resolve-env` lee `github.ref_name` (la rama que recibió el merge), lo valida contra `dev|test|prod` y lo publica como output `environment`.
3. `terraform-apply` usa ese output para `terraform workspace select <env>` y `-var-file=environments/<env>.tfvars`.

**El YAML ([cd.yml](../../.github/workflows/cd.yml)):**
```yaml
on:
  push:
    branches: [dev, test, prod]          # solo merges (push directo bloqueado)

concurrency:
  group: cd-${{ github.ref_name }}       # un deploy a la vez POR ambiente
  cancel-in-progress: false

jobs:
  resolve-env:
    outputs:
      environment: ${{ steps.detect.outputs.environment }}
    steps:
      - id: detect
        env:
          TARGET_BRANCH: ${{ github.ref_name }}   # dev | test | prod
        run: |
          if ($env:TARGET_BRANCH -notin @('dev','test','prod')) { exit 1 }
          "environment=$env:TARGET_BRANCH" | Out-File $env:GITHUB_OUTPUT -Append

  terraform-apply:
    needs: resolve-env
    environment: ${{ needs.resolve-env.outputs.environment }}   # GitHub Environment
    steps:
      - run: ./scripts/ci/terraform.ps1 -Action apply -Environment ${{ needs.resolve-env.outputs.environment }}
```

**Dentro de [terraform.ps1](../../scripts/ci/terraform.ps1):**
```powershell
terraform init -input=false -reconfigure
terraform workspace select -or-create $Environment      # <- seleccion dinamica
if ((terraform workspace show) -ne $Environment) { throw }   # verificacion
terraform apply -auto-approve -var-file=environments/$Environment.tfvars
```

**En el pre-merge (ci.yml) es igual, pero con la rama destino del PR:** `TARGET_ENV: ${{ github.base_ref }}`. Un PR `dev → test` hace `terraform plan` en el workspace **test**, que es justo lo que el merge va a aplicar. El plan se adjunta al run como artefacto `terraform-plan-<env>-pr<N>` y aparece en el *Job Summary*.

**Por qué es seguro:**
- El valor sale de GitHub (`ref_name`), no de un input editable.
- Se valida contra una lista cerrada.
- `concurrency` serializa los despliegues por ambiente.
- El lock de S3 (`use_lockfile`) impide dos applies simultáneos sobre el mismo estado.
- `environment:` registra cada despliegue en GitHub → *Environments* (historial por ambiente).

---

## Pregunta guía 3

### ¿Qué métrica o condición evalúa su etapa de Canary Deployment antes de promover el tráfico del 20% al 100% en Kubernetes?

> Detalle completo, resultados reales y demo del rollback en [04-kubernetes-canary.md](04-kubernetes-canary.md).

**Respuesta corta:** el canary corre como un Deployment aparte con label `track=canary`, detrás del mismo Service, con 1 réplica de 5 (**20%** del tráfico). Durante la ventana de análisis se evalúan tres condiciones:
1. **Readiness/health:** el canary pasa `/health` (rollout `Available`) y no tiene reinicios.
2. **Tasa de error en CloudWatch:** `ErrorCount / RequestCount` con `Track=canary` en el namespace `AegisVolt/<env>`, por debajo del umbral.
3. **Alarma** `aegisvolt-<env>-<servicio>-canary-errors` en estado `OK`.

Si se cumplen las tres, se actualiza el Deployment estable a la nueva imagen (100%) y se elimina el canary. Si alguna falla, se borra el canary (**rollback automático**) y el job falla.

---

## Otras preguntas probables

**¿Por qué solo merge commit y no squash o rebase?** La promoción es `dev → test → prod` con los **mismos commits**. Un squash crearía en `test` un commit distinto al de `dev`. En la siguiente promoción Git vería historias divergentes y aparecerían los "merge conflicts cruzados" que el enunciado quiere evitar. Con merge commits, `test` siempre es un ancestro de `dev` y `prod` de `test`.

**¿Cómo se impide un PR `feature/x → test` o `dev → prod`?** El job `promotion-guard` es un check obligatorio:

| Destino | Origen permitido |
|---------|------------------|
| `dev` | `feature/*` |
| `test` | `dev` |
| `prod` | `test` |

Cualquier otro origen hace fallar el check y el merge queda bloqueado. También rechaza PRs desde forks.

**¿Por qué los jobs de CI están encadenados con `needs`?** Por *fail fast*: si `lint-build` falla, no tiene sentido gastar tiempo en las pruebas. `terraform-plan` corre en paralelo a las pruebas porque solo depende de `promotion-guard`.

**¿Qué pasa si dos PRs se fusionan a `dev` casi al mismo tiempo?** `concurrency: cd-dev` con `cancel-in-progress: false` encola el segundo despliegue. Nunca se cancela un apply a medias, porque eso dejaría el estado inconsistente.

**¿Por qué un runner self-hosted? ¿Es seguro con un repo público?** Floci corre en `localhost`. Los riesgos están mitigados así:
- El repo exige **aprobación** para ejecutar workflows de contribuidores externos.
- `promotion-guard` rechaza PRs de forks.
- Ningún secreto real está en juego, porque Floci usa credenciales `test`.

En AWS real se usarían runners hospedados con OIDC hacia un rol IAM.

**¿Dónde se ve el historial de despliegues por ambiente?** GitHub → *Code → Environments* (`dev`, `test`, `prod`): cada job con `environment:` registra un despliegue con su commit.

**¿Qué es un GitHub Environment y por qué no tiene revisores en prod?** Es el destino lógico de un despliegue: guarda su historial y puede llevar reglas de protección. Como la entrega es individual, un revisor obligatorio bloquearía a la única persona del proyecto, porque GitHub no deja aprobar tu propio deploy si activas *prevent self-review*. La puerta hacia prod es el PR `test → prod` con sus 6 checks.
