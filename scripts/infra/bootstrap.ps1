# Crea (o actualiza) el backend remoto de Terraform: bucket S3 versionado.
# Idempotente: si el bucket ya existe solo hace init + apply sobre el estado remoto.
#
#   .\scripts\infra\bootstrap.ps1
#
# Primera ejecucion (bucket inexistente):
#   1. backend_override.tf fuerza un backend LOCAL temporal
#   2. terraform apply crea el bucket con versioning
#   3. se borra el override y "terraform init -migrate-state" sube el estado
#      del bootstrap a s3://aegisvolt-tfstate/bootstrap/terraform.tfstate
. "$PSScriptRoot\..\ci\common.ps1"
Set-FlociEnvironment

$dir = Join-Path $RepoRoot 'infra\bootstrap'
$override = Join-Path $dir 'backend_override.tf'
$localState = Join-Path $dir 'bootstrap.local.tfstate'
Set-Location $dir

$bucketExists = Test-NativeSuccess aws @('s3api', 'head-bucket', '--bucket', 'aegisvolt-tfstate')

if ($bucketExists) {
    Write-Host 'Bucket de estado existente: init + apply sobre backend S3.'
    Invoke-Native terraform @('init', '-input=false', '-reconfigure')
    Invoke-Native terraform @('apply', '-auto-approve', '-input=false')
    exit 0
}

Write-Host 'Bucket de estado inexistente: bootstrap con backend local temporal.'
@'
# TEMPORAL - generado por scripts/infra/bootstrap.ps1. No versionar.
terraform {
  backend "local" {
    path = "bootstrap.local.tfstate"
  }
}
'@ | Out-File -FilePath $override -Encoding ascii

try {
    Invoke-Native terraform @('init', '-input=false', '-reconfigure')
    Invoke-Native terraform @('apply', '-auto-approve', '-input=false')
} finally {
    Remove-Item $override -ErrorAction SilentlyContinue
}

Write-Host 'Migrando el estado del bootstrap al bucket S3...'
Invoke-Native terraform @('init', '-input=false', '-migrate-state', '-force-copy')
Remove-Item $localState, "$localState.backup" -ErrorAction SilentlyContinue
Invoke-Native terraform @('state', 'list')
Write-Host 'Bootstrap completo: s3://aegisvolt-tfstate/bootstrap/terraform.tfstate'
