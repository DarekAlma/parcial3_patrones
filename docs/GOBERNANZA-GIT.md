# Gobernanza de Git y CI/CD - AegisVolt

## Ramas de ambiente

| Rama | Ambiente | Workspace Terraform | Namespace K8s |
|------|----------|---------------------|---------------|
| `dev`  | dev  | `dev`  | `aegisvolt-dev`  |
| `test` | test | `test` | `aegisvolt-test` |
| `prod` | prod | `prod` | `aegisvolt-prod` |

`dev` es la rama por defecto. `test` y `prod` nacen de `dev`, así que las tres comparten la misma historia.

## Flujo de promoción (estricto y lineal)

```
feature/*  --PR-->  dev  --PR-->  test  --PR-->  prod
               (deploy dev)  (deploy test)  (deploy prod)
```

1. Crear la rama desde `dev`: `git switch dev && git pull && git switch -c feature/<nombre>`.
2. Abrir PR `feature/<nombre> -> dev`.
3. Validado en dev: abrir PR `dev -> test`.
4. Validado en test: abrir PR `test -> prod`.

El job `promotion-guard` hace cumplir la cadena: un PR `feature/x -> test` o `dev -> prod` falla y no se puede fusionar.

Solo se permite **merge commit**. Squash y rebase quedan deshabilitados porque reescriben los commits. Así `dev`, `test` y `prod` divergirían y aparecerían conflictos cruzados en cada promoción.

## Reglas de protección (ruleset `protected-env-branches`)

Archivo: [`.github/rulesets/protected-env-branches.json`](../.github/rulesets/protected-env-branches.json). Aplica a `dev`, `test` y `prod`, **sin bypass para nadie** (ni el administrador).

| Regla | Efecto |
|-------|--------|
| `non_fast_forward` | Bloquea `git push --force`. |
| `pull_request` | Bloquea el push directo; todo cambio entra por PR. |
| `required_status_checks` | Merge deshabilitado hasta que pasen `promotion-guard`, `lint-build`, `unit-tests`, `integration-tests`, `e2e-tests` y `terraform-plan`. |
| `deletion` | Impide borrar las ramas de ambiente. |

Los checks están atados a la app GitHub Actions (`integration_id: 15368`). Nadie puede marcarlos en verde a mano por la API de statuses.

### Demostración: push bloqueado

```powershell
git switch test
git commit --allow-empty -m "intento directo"
git push origin test            # rechazado: "Changes must be made through a pull request"
git push --force origin test    # rechazado: "Cannot force-push to this branch"
git reset --hard origin/test    # deshacer el commit local
```

## Pipelines

| Archivo | Evento | Qué hace |
|---------|--------|----------|
| [`ci.yml`](../.github/workflows/ci.yml) | `pull_request` a dev/test/prod | promotion-guard, lint-build, unit, integration, e2e, terraform-plan sobre el workspace de la **rama destino** (`github.base_ref`). |
| [`cd.yml`](../.github/workflows/cd.yml) | `push` a dev/test/prod (solo ocurre por merge) | Detecta la rama (`github.ref_name`), `terraform workspace select <env>`, `terraform apply -auto-approve` y canary en Kubernetes. |

### Detección dinámica del ambiente (post-merge)

`push` a una rama protegida solo puede venir de un PR fusionado. `github.ref_name` es la rama que recibió el merge. El job `resolve-env` la valida contra `dev|test|prod` y la expone como output. Ese output alimenta:

- `scripts/ci/terraform.ps1 -Environment <env>`, que ejecuta `terraform workspace select -or-create <env>` y verifica con `terraform workspace show` antes del apply.
- `environment:` de GitHub, que guarda el historial de despliegues por ambiente.
- `concurrency: cd-<env>`, para que no corran dos despliegues simultáneos sobre el mismo ambiente.

## Runner self-hosted

Floci corre en el PC local (`localhost:4566`), así que todos los jobs usan un runner self-hosted con la etiqueta `aegisvolt` (`runs-on: [self-hosted, aegisvolt]`). Ese runner ve Floci, Docker y Kubernetes. Así el `tfstate` persiste en el bucket S3 versionado y se pueden mostrar sus versiones.

- Instalación: `scripts/github/setup-runner.ps1`, que instala el runner fuera del repo en `C:\actions-runner-aegisvolt`.
- Arranque: `C:\actions-runner-aegisvolt\run.cmd`. Debe estar corriendo, igual que Floci, para que los checks se ejecuten.
- Seguridad: el repo es público. Los workflows de PRs de contribuidores externos requieren aprobación y `promotion-guard` rechaza PRs desde forks.

## Configuración reproducible

Toda la configuración de GitHub está en código:

```powershell
gh auth login
.\scripts\github\setup-repo.ps1     # repo, ramas, ruleset, environments
.\scripts\github\setup-runner.ps1   # runner self-hosted
```
