# Utilidades compartidas por los scripts de CI/CD.
$ErrorActionPreference = 'Stop'

$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:ValidEnvironments = @('dev', 'test', 'prod')

function Assert-Environment([string]$Environment) {
    if ($Environment -notin $script:ValidEnvironments) {
        throw "Ambiente invalido '$Environment'. Valores permitidos: $($script:ValidEnvironments -join ', ')."
    }
}

# Ejecuta un binario nativo y falla si su exit code no es 0
# (PowerShell 5.1 no lo hace por defecto).
function Invoke-Native {
    param([Parameter(Mandatory)][string]$Command, [string[]]$Arguments = @())
    Write-Host "> $Command $($Arguments -join ' ')"
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "'$Command' termino con exit code $LASTEXITCODE." }
}

function Test-NodeWorkspace {
    Test-Path (Join-Path $script:RepoRoot 'package.json')
}
