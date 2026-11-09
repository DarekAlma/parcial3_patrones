# Lista y restaura versiones anteriores del terraform.tfstate de un ambiente.
# El bucket aegisvolt-tfstate tiene Versioning Enabled: cada apply crea una
# version nueva y las anteriores quedan como backups.
#
#   .\scripts\infra\restore-state.ps1 -Environment dev                  # listar
#   .\scripts\infra\restore-state.ps1 -Environment dev -VersionId <id>  # restaurar
#
# Restaurar NO borra la version corrupta: se sube la version buena como una
# version NUEVA (terraform state push), asi el historial queda intacto.
param(
    [Parameter(Mandatory)][string]$Environment,
    [string]$VersionId
)
. "$PSScriptRoot\..\ci\common.ps1"
Assert-Environment $Environment
Set-FlociEnvironment

$bucket = 'aegisvolt-tfstate'
$key = "env:/$Environment/aegisvolt/terraform.tfstate"

if (-not $VersionId) {
    Write-Host "Versiones de s3://$bucket/$key (la primera es la actual):"
    # --prefix tambien devuelve terraform.tfstate.tflock: se filtra por la key exacta.
    $versions = ((aws s3api list-object-versions --bucket $bucket --prefix $key --output json) -join "`n" | ConvertFrom-Json).Versions
    $versions | Where-Object Key -eq $key |
        Select-Object VersionId, LastModified, IsLatest, Size |
        Format-Table -AutoSize
    exit 0
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) "tfstate-$Environment-$VersionId.json"
Invoke-Native aws @('s3api', 'get-object', '--bucket', $bucket, '--key', $key, '--version-id', $VersionId, $tmp)

# Validacion minima antes de restaurar: debe ser un estado de Terraform del mismo linaje.
$restored = Get-Content $tmp -Raw | ConvertFrom-Json
if (-not $restored.lineage -or $null -eq $restored.serial) { throw 'La version descargada no es un tfstate valido.' }
Write-Host "Version $VersionId -> serial $($restored.serial), lineage $($restored.lineage), $(@($restored.resources).Count) recursos"

Set-Location (Join-Path $RepoRoot 'infra\terraform')
Invoke-Native terraform @('init', '-input=false', '-reconfigure')
Invoke-Native terraform @('workspace', 'select', $Environment)

$current = (terraform state pull | Out-String | ConvertFrom-Json)
if ($current.lineage -ne $restored.lineage) {
    throw "Lineage distinto ($($current.lineage) vs $($restored.lineage)): no es el mismo estado."
}

# -force: el serial restaurado es menor que el actual.
Invoke-Native terraform @('state', 'push', '-force', $tmp)
Remove-Item $tmp
Write-Host "Estado de '$Environment' restaurado a la version $VersionId. Ejecuta terraform plan para verificar."
