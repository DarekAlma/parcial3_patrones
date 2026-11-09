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
# (PowerShell 5.1 no lo hace por defecto). Dentro se usa 'Continue' porque en
# PS 5.1 cualquier escritura a stderr (warnings de terraform, progreso de git)
# se convierte en error terminante con 'Stop'; se decide solo por el exit code.
function Invoke-Native {
    param([Parameter(Mandatory)][string]$Command, [string[]]$Arguments = @())
    $ErrorActionPreference = 'Continue'
    Write-Host "> $Command $($Arguments -join ' ')"
    & $Command @Arguments 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -ne 0) { throw "'$Command' termino con exit code $LASTEXITCODE." }
}

# $true si el comando termina con exit code 0. No imprime nada (para verificaciones).
function Test-NativeSuccess {
    param([Parameter(Mandatory)][string]$Command, [string[]]$Arguments = @())
    $ErrorActionPreference = 'Continue'
    & $Command @Arguments *> $null
    return ($LASTEXITCODE -eq 0)
}

# Variables de entorno para hablar con Floci (emulador local, NO AWS real).
# Respeta valores ya definidos (p. ej. por el workflow).
function Set-FlociEnvironment {
    $defaults = @{
        AWS_ENDPOINT_URL      = 'http://localhost:4566'
        AWS_DEFAULT_REGION    = 'us-east-1'
        AWS_REGION            = 'us-east-1'
        AWS_ACCESS_KEY_ID     = 'test'
        AWS_SECRET_ACCESS_KEY = 'test'
    }
    foreach ($k in $defaults.Keys) {
        if (-not [Environment]::GetEnvironmentVariable($k)) {
            [Environment]::SetEnvironmentVariable($k, $defaults[$k])
        }
    }
}

function Test-NodeWorkspace {
    Test-Path (Join-Path $script:RepoRoot 'package.json')
}
