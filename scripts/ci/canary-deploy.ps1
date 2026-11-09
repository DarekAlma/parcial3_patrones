# Job canary-deploy (CD): despliegue progresivo de UN microservicio.
#
#   1. Si la imagen nueva == stable: no hay nada que promover (servicio sin cambios).
#   2. Canary: <svc>-canary con la imagen nueva y 1 replica junto a 4 stable
#      => el Service reparte ~20% del trafico al canary (1 de 5 pods).
#   3. Ventana de analisis: trafico sintetico al Service + espera de metricas.
#   4. Gate (TODAS deben cumplirse):
#        a) canary Ready y sin reinicios
#        b) RequestCount(Track=canary) >= MinRequests     (hubo trafico real al canary)
#        c) ErrorCount / RequestCount (Track=canary) <= MaxErrorRate   [CloudWatch]
#        d) alarma aegisvolt-<env>-<svc>-canary-errors != ALARM        [CloudWatch]
#   5. OK  -> promocion: stable pasa a la imagen nueva (rolling) y canary a 0.
#      NOK -> rollback automatico: canary a 0, stable intacto, el job falla.
#
# Demo de rollback (sustentacion):
#   .\scripts\ci\canary-deploy.ps1 -Environment dev -Service billing-wallet-service -Version demo -Force -InjectErrorRate 0.6
param(
    [Parameter(Mandatory)][string]$Environment,
    [Parameter(Mandatory)][string]$Service,
    [string]$Version = 'manual',
    [int]$Requests = 60,
    [int]$MinRequests = 5,
    [double]$MaxErrorRate = 0.05,
    [int]$MetricsWaitSeconds = 20,
    # Fuerza el canary aunque la imagen no haya cambiado (demos).
    [switch]$Force,
    # Inyecta errores 5xx SOLO en el canary (demo de rollback automatico).
    [double]$InjectErrorRate = 0
)
. "$PSScriptRoot\..\k8s\k8s.ps1"
Assert-Environment $Environment
Set-FlociEnvironment
Set-Location $RepoRoot
$null = Get-AegisService $Service

if (-not (Test-Path (Join-Path $RepoRoot 'k8s\base\kustomization.yaml'))) {
    Write-Host 'Sin manifiestos k8s: se omite el canary.'; exit 0
}

$kc = Get-Kubeconfig -Environment $Environment
$canaryDeploy = "$Service-canary"
$newImage = Publish-ServiceImage -Environment $Environment -Name $Service
$stableImage = Get-DeployedImage -Kubeconfig $kc -Deployment $Service

if (-not $Force -and $stableImage -eq $newImage) {
    Write-Summary @("### $Service ($Environment): sin cambios", '', "La imagen ``$($newImage.Split(':')[-1])`` ya es la version stable. No hay canary.")
    exit 0
}

$stableReplicas = [int](Get-KubectlOutput -Kubeconfig $kc -Arguments @('get', 'deployment', $Service, '-o', 'jsonpath={.spec.replicas}'))
$canaryWeight = [math]::Round(100 / ($stableReplicas + 1))
Write-Host "Canary $Service : $($stableImage.Split(':')[-1]) -> $($newImage.Split(':')[-1])  (1 de $($stableReplicas + 1) pods = ~$canaryWeight% del trafico)"

function Stop-Canary([string]$Reason) {
    Invoke-Kubectl -Kubeconfig $kc -Arguments @('scale', "deployment/$canaryDeploy", '--replicas=0') | Out-Null
    Invoke-Kubectl -Kubeconfig $kc -Arguments @('set', 'env', "deployment/$canaryDeploy", 'INJECT_ERROR_RATE-') | Out-Null
    Write-Host "Canary detenido: $Reason"
}

# ---------------------------------------------------------------- 2. canary
$startTime = (Get-Date).ToUniversalTime().AddSeconds(-5)
Invoke-Kubectl -Kubeconfig $kc -Arguments @('set', 'image', "deployment/$canaryDeploy", "app=$newImage")
if ($InjectErrorRate -gt 0) {
    Invoke-Kubectl -Kubeconfig $kc -Arguments @('set', 'env', "deployment/$canaryDeploy", "INJECT_ERROR_RATE=$InjectErrorRate")
}
Invoke-Kubectl -Kubeconfig $kc -Arguments @('scale', "deployment/$canaryDeploy", '--replicas=1')
try {
    Invoke-Kubectl -Kubeconfig $kc -Arguments @('rollout', 'status', "deployment/$canaryDeploy", '--timeout=180s')
} catch {
    Stop-Canary 'el canary no llego a Ready'
    Write-Summary @("### $Service ($Environment): ROLLBACK", '', 'El canary no paso el readiness probe.')
    exit 1
}

# ------------------------------------------- 3. trafico sintetico al Service
# Se ejecuta desde un pod de la plataforma (permitido por la NetworkPolicy) y
# golpea el Service: kube-proxy reparte entre stable y canary.
$targets = @{
    'station-reservation-service' = @{ Path = '/stations'; Method = 'GET'; Body = '' }
    'billing-wallet-service'      = @{ Path = '/wallets'; Method = 'GET'; Body = '' }
    'energy-dispatch-service'     = @{ Path = '/sessions?status=ACTIVE'; Method = 'GET'; Body = '' }
    # Sin comillas dobles: PowerShell 5.1 las altera al pasar argumentos a kubectl.
    'graphql-gateway'             = @{ Path = '/graphql'; Method = 'POST'; Body = "{query:'{ environment { environment version track } stations { id availableConnectors } }'}" }
}
$t = $targets[$Service]
$probeFrom = if ($Service -eq 'graphql-gateway') { 'deployment/station-reservation-service' } else { 'deployment/graphql-gateway' }
# Una conexion TCP NUEVA por request (agent:false): kube-proxy balancea por
# conexion, asi que con keep-alive todo el trafico iria a un solo pod y el
# reparto 80/20 no se veria. Clientes reales distintos = conexiones distintas.
$body = if ($t.Body) { "JSON.stringify($($t.Body))" } else { 'null' }
$js = @"
const http=require('http');
const body=$body;
const once=()=>new Promise((res)=>{
  const req=http.request({host:'$Service.aegisvolt.svc.cluster.local',port:8080,path:'$($t.Path)',method:'$($t.Method)',agent:false,
    headers:{'content-type':'application/json','x-correlation-id':'canary-probe'}},(r)=>{r.resume();r.on('end',()=>res({ok:r.statusCode<500,canary:r.headers['x-aegis-track']==='canary'}));});
  req.on('error',()=>res({ok:false,canary:false}));
  if(body)req.write(body);
  req.end();
});
(async()=>{let ok=0,fail=0,canary=0;
  for(let i=0;i<$Requests;i++){const r=await once();r.ok?ok++:fail++;if(r.canary)canary++;}
  console.log(JSON.stringify({ok,fail,canary}));})();
"@
$probe = Get-KubectlOutput -Kubeconfig $kc -Arguments @('exec', $probeFrom, '--', 'node', '-e', $js)
Write-Host "Trafico sintetico ($Requests requests): $probe"

Write-Host "Esperando $MetricsWaitSeconds s a que los logs lleguen a CloudWatch y se publiquen las metricas..."
Start-Sleep -Seconds $MetricsWaitSeconds

# ------------------------------------------------------- 4. gate CloudWatch
function Get-CanaryMetric([string]$Metric) {
    $end = (Get-Date).ToUniversalTime().AddMinutes(1)
    $json = aws cloudwatch get-metric-statistics --namespace "AegisVolt/$Environment" --metric-name $Metric `
        --dimensions "Name=Service,Value=$Service" 'Name=Track,Value=canary' `
        --start-time $startTime.ToString('yyyy-MM-ddTHH:mm:ssZ') --end-time $end.ToString('yyyy-MM-ddTHH:mm:ssZ') `
        --period 60 --statistics Sum --output json
    $points = ((($json -join "`n") | ConvertFrom-Json).Datapoints)
    return [double](($points | Measure-Object -Property Sum -Sum).Sum)
}
$requestsSeen = Get-CanaryMetric 'RequestCount'
$errorsSeen = Get-CanaryMetric 'ErrorCount'
$errorRate = if ($requestsSeen -gt 0) { $errorsSeen / $requestsSeen } else { 1 }
$alarm = (aws cloudwatch describe-alarms --alarm-names "aegisvolt-$Environment-$Service-canary-errors" --query 'MetricAlarms[0].StateValue' --output text).Trim()
$restarts = [int](((Get-KubectlOutput -Kubeconfig $kc -Arguments @('get', 'pods', '-l', "app.kubernetes.io/name=$Service,aegisvolt.io/track=canary", '-o', 'jsonpath={.items[*].status.containerStatuses[*].restartCount}')) -split '\s+' | Where-Object { $_ } | Measure-Object -Sum).Sum)

$checks = [ordered]@{
    'Canary Ready y sin reinicios'                                  = ($restarts -eq 0)
    "RequestCount(Track=canary) >= $MinRequests"                    = ($requestsSeen -ge $MinRequests)
    "Tasa de error canary <= $([math]::Round($MaxErrorRate * 100))%" = ($errorRate -le $MaxErrorRate)
    'Alarma canary-errors != ALARM'                                 = ($alarm -ne 'ALARM')
}
$passed = -not ($checks.Values -contains $false)
$summary = @(
    "### Canary ``$Service`` en ``$Environment``: $(if ($passed) { 'PROMOVIDO a 100%' } else { 'ROLLBACK automatico' })",
    '',
    "Imagen: ``$($stableImage -replace '.*:', '')`` -> ``$($newImage -replace '.*:', '')``  |  peso canary ~$canaryWeight%  |  trafico sintetico: $probe",
    '',
    '| Metrica CloudWatch (AegisVolt/' + $Environment + ', Track=canary) | Valor |', '|---|---|',
    "| RequestCount | $requestsSeen |",
    "| ErrorCount | $errorsSeen |",
    "| Tasa de error | $([math]::Round($errorRate * 100, 2))% |",
    "| Alarma | $alarm |",
    "| Reinicios del canary | $restarts |",
    '',
    '| Condicion | Resultado |', '|---|---|'
) + ($checks.GetEnumerator() | ForEach-Object { "| $($_.Key) | $(if ($_.Value) { 'OK' } else { 'FALLA' }) |" })

# -------------------------------------------------- 5. promover o revertir
if (-not $passed) {
    Stop-Canary 'el gate de CloudWatch no se cumplio'
    Write-Summary $summary
    exit 1
}

Invoke-Kubectl -Kubeconfig $kc -Arguments @('set', 'image', "deployment/$Service", "app=$newImage")
Invoke-Kubectl -Kubeconfig $kc -Arguments @('annotate', "deployment/$Service", '--overwrite', "aegisvolt.io/promoted-from-canary=$Version")
Invoke-Kubectl -Kubeconfig $kc -Arguments @('rollout', 'status', "deployment/$Service", '--timeout=300s')
Stop-Canary 'promovido al 100%'
Write-Summary $summary
