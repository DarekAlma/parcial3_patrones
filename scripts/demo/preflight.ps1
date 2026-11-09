# Chequeo previo a la sustentacion: valida que todo este arriba e imprime las
# URLs del dia (los ids de API Gateway cambian si se recrea la infraestructura).
#
#   .\scripts\demo\preflight.ps1            # solo verifica
#   .\scripts\demo\preflight.ps1 -Fix       # ademas levanta Floci y Prefect si estan abajo
param([switch]$Fix)
. "$PSScriptRoot\..\k8s\k8s.ps1"
Set-FlociEnvironment
$ErrorActionPreference = 'Continue'
$results = [System.Collections.Generic.List[object]]::new()
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
    $results.Add([pscustomobject]@{ Chequeo = $Name; Estado = $(if ($Ok) { 'OK' } else { 'FALLA' }); Detalle = $Detail })
}
function Http([string]$Url) {
    try { (Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 8).StatusCode } catch { 0 }
}

# 1. Docker + Floci
$dockerOk = Test-NativeSuccess docker @('info')
Check 'Docker Desktop' $dockerOk
if ($Fix -and (Http 'http://localhost:4566/_floci/health') -ne 200) {
    docker compose -f (Join-Path $RepoRoot 'infra\floci\docker-compose.yml') up -d | Out-Null
    Start-Sleep 20
}
$floci = Http 'http://localhost:4566/_floci/health'
Check 'Floci (localhost:4566, modo persistent)' ($floci -eq 200) ((docker inspect floci --format '{{range .Config.Env}}{{println .}}{{end}}' 2>$null | Select-String 'STORAGE_MODE') -join '')

# 2. Backend de Terraform
$versions = "$(aws s3api list-object-versions --bucket aegisvolt-tfstate --prefix env:/dev/aegisvolt/terraform.tfstate --query "length(Versions[?Key=='env:/dev/aegisvolt/terraform.tfstate'])" --output text)".Trim()
Check 'Bucket aegisvolt-tfstate (versiones del tfstate de dev)' ([int]($versions -replace '\D', '0') -gt 0) "$versions versiones"

# 3. Ambientes: EKS, API Gateway, UI, GraphQL
$urls = [ordered]@{}
foreach ($e in $ValidEnvironments) {
    $status = "$(aws eks describe-cluster --name "aegisvolt-$e" --query cluster.status --output text 2>$null)".Trim()
    Check "EKS aegisvolt-$e" ($status -eq 'ACTIVE') $status
    $apiId = "$(aws apigatewayv2 get-apis --query "Items[?Name=='aegisvolt-$e'].ApiId | [0]" --output text)".Trim()
    $base = "http://$apiId.execute-api.localhost.floci.io:4566"
    $urls[$e] = $base
    Check "UI $e ($base/)" ((Http "$base/") -eq 200)
    try {
        $body = @{ query = '{ environment { environment flagAdminEnabled } }' } | ConvertTo-Json -Compress
        $gq = Invoke-RestMethod -Method Post -Uri "$base/graphql" -ContentType 'application/json' -Body $body -TimeoutSec 10
        Check "GraphQL $e" ($gq.data.environment.environment -eq $e) "flagAdmin=$($gq.data.environment.flagAdminEnabled)"
    } catch { Check "GraphQL $e" $false $_.Exception.Message }
    $fault = "$(aws dynamodb get-item --table-name "aegisvolt-feature-flags-$e" --key '{\"flag\":{\"S\":\"SIMULATE_CHARGER_HARDWARE_FAULT\"}}' --query Item.enabled.BOOL --output text)".Trim()
    Check "Flag de falla apagada en $e" ($fault -eq 'False') "SIMULATE_CHARGER_HARDWARE_FAULT=$fault"
}

# 4. Prefect
if ($Fix -and (Http 'http://localhost:4200/api/health') -ne 200) {
    docker compose -f (Join-Path $RepoRoot 'prefect\docker-compose.yml') up -d | Out-Null
    Start-Sleep 25
}
Check 'Prefect (http://localhost:4200)' ((Http 'http://localhost:4200/api/health') -eq 200)

# 5. Runner de GitHub Actions
$runner = Get-Process -Name 'Runner.Listener' -ErrorAction SilentlyContinue
Check 'Runner self-hosted (Runner.Listener)' ([bool]$runner) 'Si falta: C:\actions-runner-aegisvolt\run.cmd'

# 6. kubeconfigs
foreach ($e in $ValidEnvironments) {
    try { $null = Get-Kubeconfig -Environment $e 6>$null; Check "kubeconfig $e" $true "$env:USERPROFILE\.kube\aegisvolt-$e.yaml" }
    catch { Check "kubeconfig $e" $false $_.Exception.Message }
}

$results | Format-Table -AutoSize -Wrap
Write-Host ''
Write-Host 'URLs del dia:' -ForegroundColor Yellow
foreach ($e in $urls.Keys) { Write-Host ("  UI {0,-5} {1}/" -f $e, $urls[$e]) }
Write-Host '  Prefect    http://localhost:4200'
Write-Host '  Floci UI   http://localhost:4566/_floci/ui'
Write-Host '  GitHub     https://github.com/DarekAlma/parcial3_patrones'
$fail = @($results | Where-Object Estado -eq 'FALLA').Count
if ($fail) { Write-Host "`n$fail chequeo(s) fallaron: revisa el Plan B en docs/GUION-DEMO.md" -ForegroundColor Red; exit 1 }
Write-Host "`nTodo listo para la demo." -ForegroundColor Green
