## Entorno AWS: Floci (emulador local)

- Uso Floci, un emulador local de AWS. NO es AWS real. No hay cuenta ni costos.
- Endpoint: http://localhost:4566 (todos los servicios en el mismo puerto).
- Región: us-east-1. Credenciales: AWS_ACCESS_KEY_ID=test, AWS_SECRET_ACCESS_KEY=test.
- Floci corre en Docker (Docker Desktop debe estar abierto):
  `docker run --rm -p 4566:4566 -v //var/run/docker.sock:/var/run/docker.sock floci/floci:latest`
- Código fuente clonado en `../FlociAWS/floci` (https://github.com/floci-io/floci).
- Antes de usar AWS CLI en PowerShell, define:
  $env:AWS_ENDPOINT_URL="http://localhost:4566"; $env:AWS_DEFAULT_REGION="us-east-1"; $env:AWS_ACCESS_KEY_ID="test"; $env:AWS_SECRET_ACCESS_KEY="test"
- En código (SDK), configura endpoint_url / endpointOverride = http://localhost:4566.
- En S3 usa path-style (forcePathStyle=true) si el SDK lo pide.
- Terraform: configura `endpoints` del provider aws apuntando a http://localhost:4566,
  con skip_credentials_validation y skip_requesting_account_id = true.
- Consola web: http://localhost:4566/_floci/ui
- Nunca uses credenciales ni recursos de AWS real.
- Si un servicio u operación falla, revisa soporte en https://floci.io/floci/services/
- Estoy en Windows 11 con PowerShell.

## Proyecto AegisVolt (parcial 3)

- Enunciado: `C:\Users\rogst\Downloads\Proyecto Final - Patrones Arquitectónicos Avanzados (AegisVolt).pdf`. Seguirlo al pie de la letra.
- Ramas de ambiente `dev`, `test`, `prod`; promoción `feature/* -> dev -> test -> prod` solo por PR (ver `docs/GOBERNANZA-GIT.md`).
- CI/CD corre en un runner self-hosted (etiqueta `aegisvolt`) en Windows. Los scripts de CI son PowerShell 5.1 (`scripts/ci/*.ps1`): el `bash` del PATH es WSL, no Git Bash.
- Los nombres de los jobs de `ci.yml` son required checks del ruleset: si se renombran, actualizar `.github/rulesets/protected-env-branches.json` y re-ejecutar `scripts/github/setup-repo.ps1`.
