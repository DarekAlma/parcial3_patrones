# Levanta el entorno completo desde cero (o lo reconcilia si ya existe):
#   1. Floci persistente (docker compose)
#   2. Backend de Terraform (bucket S3 versionado)
#   3. terraform apply en los workspaces pedidos
#
#   .\scripts\infra\up.ps1                         # dev, test y prod
#   .\scripts\infra\up.ps1 -Environments dev       # solo dev
#
# En el flujo normal el apply de cada ambiente lo hace el pipeline de CD al
# fusionar un PR; este script es para preparar la maquina local o una demo.
param([string[]]$Environments = @('dev', 'test', 'prod'))
. "$PSScriptRoot\..\ci\common.ps1"
Set-FlociEnvironment

Invoke-Native docker @('compose', '-f', (Join-Path $RepoRoot 'infra\floci\docker-compose.yml'), 'up', '-d')

Write-Host 'Esperando a Floci...'
$deadline = (Get-Date).AddMinutes(2)
do {
    try { Invoke-RestMethod -Uri 'http://localhost:4566/_floci/health' -TimeoutSec 3 | Out-Null; $ready = $true }
    catch { $ready = $false; Start-Sleep -Seconds 2 }
} until ($ready -or (Get-Date) -gt $deadline)
if (-not $ready) { throw 'Floci no respondio en http://localhost:4566.' }

& "$PSScriptRoot\bootstrap.ps1"
foreach ($e in $Environments) {
    Assert-Environment $e
    & "$RepoRoot\scripts\ci\terraform.ps1" -Action apply -Environment $e
}
