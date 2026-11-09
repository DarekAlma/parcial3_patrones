# Jobs unit-tests / integration-tests / e2e-tests.
#   unit        : logica de negocio y compensaciones SAGA (sin red).
#   integration : DynamoDB real en Floci (tablas efimeras) + endpoints HTTP/GraphQL.
#   e2e         : los 4 servicios como procesos + flujo completo por GraphQL
#                 (feliz, fallo de hardware con rollback, fondos insuficientes, flags).
# Las suites integration/e2e crean tablas aegisvolt-it-* y las borran al terminar:
# nunca tocan las tablas de los ambientes dev/test/prod.
param(
    [Parameter(Mandatory)][ValidateSet('unit', 'integration', 'e2e')][string]$Suite,
    [string]$Environment = 'dev'
)
. "$PSScriptRoot\common.ps1"
Assert-Environment $Environment
Set-FlociEnvironment
Set-Location $RepoRoot

$ran = $false

if (Test-NodeWorkspace) {
    if (-not (Test-Path node_modules)) { Invoke-Native npm @('ci', '--no-audit', '--no-fund') }
    $reportDir = Join-Path $RepoRoot 'reports'
    New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
    Invoke-Native npx @('vitest', 'run', '--project', $Suite, '--reporter=default', '--reporter=junit', "--outputFile.junit=reports/$Suite-junit.xml")
    $ran = $true
}

# Reglas de auditoria de Prefect (logica pura, sin Prefect ni AWS).
if ($Suite -eq 'unit' -and (Test-Path 'prefect\requirements-test.txt')) {
    Invoke-Native python @('-m', 'pip', 'install', '-q', '--disable-pip-version-check', '-r', 'prefect\requirements-test.txt')
    Invoke-Native python @('-m', 'pytest', 'prefect\tests', '-q', '--junitxml=reports/prefect-unit-junit.xml')
    $ran = $true
}

if (-not $ran) { Write-Host "Sin pruebas '$Suite' todavia: nada que ejecutar." }
