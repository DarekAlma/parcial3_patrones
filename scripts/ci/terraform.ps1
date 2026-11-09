# Jobs terraform-plan (CI) y terraform-apply (CD).
# El ambiente determina el workspace: terraform workspace select <dev|test|prod>.
# El estado remoto vive en S3 (Floci) bajo env:/<ambiente>/..., aislado por workspace.
param(
    [Parameter(Mandatory)][ValidateSet('plan', 'apply')][string]$Action,
    [Parameter(Mandatory)][string]$Environment
)
. "$PSScriptRoot\common.ps1"
Assert-Environment $Environment

$tfDir = Join-Path $RepoRoot 'infra\terraform'
if (-not (Get-ChildItem -Path $tfDir -Filter *.tf -ErrorAction SilentlyContinue)) {
    Write-Host 'Sin modulos Terraform todavia: se omite.'
    exit 0
}
Set-Location $tfDir

$varFile = "environments/$Environment.tfvars"
$env:TF_IN_AUTOMATION = 'true'

Invoke-Native terraform @('init', '-input=false', '-reconfigure')
Invoke-Native terraform @('workspace', 'select', '-or-create', $Environment)

$current = (terraform workspace show).Trim()
if ($current -ne $Environment) { throw "Workspace activo '$current' no coincide con '$Environment'." }
Write-Host "Workspace activo: $current"

switch ($Action) {
    'plan' {
        Invoke-Native terraform @('plan', '-input=false', '-lock-timeout=60s', "-var-file=$varFile", '-out=tfplan')
        terraform show -no-color tfplan | Out-File -FilePath plan.txt -Encoding utf8
        if ($env:GITHUB_STEP_SUMMARY) {
            $summary = @("## terraform plan - workspace ``$Environment``", '', '```', (Get-Content plan.txt -Raw), '```')
            $summary | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8
        }
    }
    'apply' {
        Invoke-Native terraform @('apply', '-auto-approve', '-input=false', '-lock-timeout=60s', "-var-file=$varFile")
    }
}
