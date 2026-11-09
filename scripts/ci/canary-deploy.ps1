# Job canary-deploy: despliegue progresivo en Kubernetes.
#   1. Despliega la version nueva como "canary" (~20% del trafico).
#   2. Evalua health checks y la tasa de errores en CloudWatch.
#   3. Si cumple el umbral promueve al 100%; si no, rollback automatico.
# La logica completa se implementa junto con los manifiestos de k8s/.
param(
    [Parameter(Mandatory)][string]$Environment,
    [Parameter(Mandatory)][string]$Service,
    [Parameter(Mandatory)][string]$Version
)
. "$PSScriptRoot\common.ps1"
Assert-Environment $Environment

$manifests = Join-Path $RepoRoot "k8s\$Service"
if (-not (Test-Path $manifests)) {
    Write-Host "Sin manifiestos k8s para '$Service' todavia: se omite el canary."
    exit 0
}

throw 'canary-deploy.ps1: implementacion pendiente (fase Kubernetes).'
