# Jobs unit-tests / integration-tests / e2e-tests.
#   unit        : logica de negocio y compensaciones SAGA (sin red).
#   integration : contra tablas DynamoDB en Floci y endpoints GraphQL.
#   e2e         : flujo completo "Reservar y Activar Carga" desde la API.
param(
    [Parameter(Mandatory)][ValidateSet('unit', 'integration', 'e2e')][string]$Suite,
    [string]$Environment = 'dev'
)
. "$PSScriptRoot\common.ps1"
Assert-Environment $Environment
Set-Location $RepoRoot

$env:AEGIS_ENV = $Environment
$ran = $false

if (Test-NodeWorkspace) {
    if (-not (Test-Path node_modules)) { Invoke-Native npm @('ci') }
    Invoke-Native npm @('run', "test:$Suite", '--if-present')
    $ran = $true
}

if ($Suite -eq 'unit' -and (Test-Path 'prefect\requirements.txt')) {
    Invoke-Native python @('-m', 'pip', 'install', '-q', '-r', 'prefect\requirements.txt')
    Invoke-Native python @('-m', 'pytest', 'prefect', '-q')
    $ran = $true
}

if (-not $ran) { Write-Host "Sin pruebas '$Suite' todavia: nada que ejecutar." }
