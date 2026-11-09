# Jobs terraform-plan (CI) y terraform-apply (CD).
# El ambiente determina el workspace: terraform workspace select <dev|test|prod>.
# El estado remoto vive en S3 (Floci) bajo env:/<ambiente>/..., aislado por workspace.
param(
    [Parameter(Mandatory)][ValidateSet('plan', 'apply')][string]$Action,
    [Parameter(Mandatory)][string]$Environment
)
. "$PSScriptRoot\common.ps1"
Assert-Environment $Environment
Set-FlociEnvironment

$tfDir = Join-Path $RepoRoot 'infra\terraform'
if (-not (Get-ChildItem -Path $tfDir -Filter *.tf -ErrorAction SilentlyContinue)) {
    Write-Host 'Sin modulos Terraform todavia: se omite.'
    exit 0
}

# Si el backend aun no existe (Floci recien creado) se crea primero.
if (-not (Test-NativeSuccess aws @('s3api', 'head-bucket', '--bucket', 'aegisvolt-tfstate'))) {
    Write-Host 'Backend S3 inexistente: ejecutando bootstrap.'
    & "$RepoRoot\scripts\infra\bootstrap.ps1"
}

Set-Location $tfDir
$varFile = "environments/$Environment.tfvars"
$env:TF_IN_AUTOMATION = 'true'

Invoke-Native terraform @('init', '-input=false', '-reconfigure')
Invoke-Native terraform @('workspace', 'select', '-or-create', $Environment)

# Verificacion explicita: nunca aplicar sobre un workspace distinto al ambiente pedido.
$current = (terraform workspace show).Trim()
if ($current -ne $Environment) { throw "Workspace activo '$current' no coincide con '$Environment'." }
Write-Host "Workspace activo: $current  (estado: s3://aegisvolt-tfstate/env:/$current/aegisvolt/terraform.tfstate)"

switch ($Action) {
    'plan' {
        Invoke-Native terraform @('plan', '-input=false', '-no-color', '-lock-timeout=60s', "-var-file=$varFile", '-out=tfplan')
        terraform show -no-color tfplan | Out-File -FilePath plan.txt -Encoding utf8
        if ($env:GITHUB_STEP_SUMMARY) {
            $planText = Get-Content plan.txt -Raw
            $headline = ($planText -split "`n" | Where-Object { $_ -match '^(Plan:|No changes)' } | Select-Object -First 1)
            @(
                "## terraform plan - workspace ``$Environment``",
                '',
                "**$headline**",
                '',
                '<details><summary>Plan completo</summary>',
                '',
                '```',
                $planText,
                '```',
                '</details>'
            ) | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8
        }
    }
    'apply' {
        Invoke-Native terraform @('apply', '-auto-approve', '-input=false', '-no-color', '-lock-timeout=60s', "-var-file=$varFile")
    }
}
