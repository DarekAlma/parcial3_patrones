# Job k8s-apply (CD): reconcilia el ambiente en su cluster EKS.
#   1. Publica en ECR las imagenes de los 4 servicios (solo si cambiaron).
#   2. Aplica los manifiestos (kustomize overlay del ambiente) conservando la
#      imagen STABLE actual: la version nueva entra SOLO por canary-deploy.ps1.
#      En el primer despliegue (no hay stable) se instala la version nueva.
#   3. Apunta el Service "floci" (endpoint de AWS en el cluster) a Floci.
#   4. Registra el nodo EKS (IP:NodePort) en el target group del NLB interno,
#      como lo haria el AWS Load Balancer Controller (TargetGroupBinding).
param([Parameter(Mandatory)][string]$Environment)
. "$PSScriptRoot\k8s.ps1"
Assert-Environment $Environment
Set-FlociEnvironment
Set-Location $RepoRoot

$kc = Get-Kubeconfig -Environment $Environment

# 1. Imagenes
$newImages = @{}
foreach ($svc in $AegisServices) { $newImages[$svc.Name] = Publish-ServiceImage -Environment $Environment -Name $svc.Name }

# 2. Manifiestos
$manifest = (& kubectl kustomize (Join-Path $RepoRoot "k8s\overlays\$Environment")) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'kubectl kustomize fallo' }
$rows = @('| Servicio | Stable | Nueva version |', '|---|---|---|')
foreach ($svc in $AegisServices) {
    $current = Get-DeployedImage -Kubeconfig $kc -Deployment $svc.Name
    $stable = if ($current) { $current } else { $newImages[$svc.Name] }
    $canaryCurrent = Get-DeployedImage -Kubeconfig $kc -Deployment "$($svc.Name)-canary"
    $canary = if ($canaryCurrent) { $canaryCurrent } else { $stable }
    $manifest = $manifest.Replace("aegisvolt/$($svc.Name):STABLE", $stable).Replace("aegisvolt/$($svc.Name):CANARY", $canary)
    $rows += "| $($svc.Name) | ``$($stable.Split(':')[-1])`` | ``$($newImages[$svc.Name].Split(':')[-1])`` |"
}
$tmp = Join-Path ([IO.Path]::GetTempPath()) "aegisvolt-$Environment-manifest.yaml"
[IO.File]::WriteAllText($tmp, $manifest)
Invoke-Native kubectl @('--kubeconfig', $kc, 'apply', '-f', $tmp)

# 3. Service "floci" -> IP de Floci en la red Docker compartida con el k3s
$flociIp = (docker inspect floci --format '{{(index .NetworkSettings.Networks \"aegisvolt\").IPAddress}}').Trim()
if (-not $flociIp) { throw 'No se encontro la IP de Floci en la red aegisvolt' }
$slice = @"
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: floci-1
  namespace: aegisvolt
  labels:
    kubernetes.io/service-name: floci
addressType: IPv4
ports:
  - name: aws
    port: 4566
    protocol: TCP
endpoints:
  - addresses: ["$flociIp"]
"@
$sliceFile = Join-Path ([IO.Path]::GetTempPath()) "aegisvolt-$Environment-floci-slice.yaml"
[IO.File]::WriteAllText($sliceFile, $slice)
Invoke-Native kubectl @('--kubeconfig', $kc, 'apply', '-f', $sliceFile)

foreach ($svc in $AegisServices) {
    Invoke-Kubectl -Kubeconfig $kc -Arguments @('rollout', 'status', "deployment/$($svc.Name)", '--timeout=240s')
}

# 4. Config del frontend: URL del API Gateway de cada ambiente (comparacion de
#    flags en vivo). El directorio montado se actualiza sin reiniciar los pods.
$peers = [ordered]@{}
foreach ($e in $ValidEnvironments) {
    $apiId = "$(aws apigatewayv2 get-apis --query "Items[?Name=='aegisvolt-$e'].ApiId | [0]" --output text)".Trim()
    if ($apiId -and $apiId -ne 'None') { $peers[$e] = "http://$apiId.execute-api.localhost.floci.io:4566" }
}
$cmFile = Join-Path ([IO.Path]::GetTempPath()) "aegisvolt-$Environment-frontend-config.json"
[IO.File]::WriteAllText($cmFile, (@{ peers = $peers } | ConvertTo-Json -Compress))
$cmYaml = (& kubectl --kubeconfig $kc -n aegisvolt create configmap frontend-config "--from-file=app-config.json=$cmFile" --dry-run=client -o yaml) -join "`n"
$cmYamlFile = "$cmFile.yaml"
[IO.File]::WriteAllText($cmYamlFile, $cmYaml)
Invoke-Native kubectl @('--kubeconfig', $kc, 'apply', '-f', $cmYamlFile)

# 5. Targets del NLB: nodos del cluster en el NodePort de cada workload expuesto
#    (graphql-gateway 30080, frontend 30081).
# "$(...)": una salida vacia de un comando nativo es AutomationNull y no admite .Trim().
$nodeIps = @("$(kubectl --kubeconfig $kc get nodes -o "jsonpath={.items[*].status.addresses[?(@.type=='InternalIP')].address}")".Trim() -split '\s+' | Where-Object { $_ })
if (-not $nodeIps) { throw 'No se pudieron obtener las IPs de los nodos del cluster' }
foreach ($binding in @(@{ Tg = 'tg-graphql'; Port = 30080 }, @{ Tg = 'tg-frontend'; Port = 30081 })) {
    $tg = "$(aws elbv2 describe-target-groups --names "aegisvolt-$Environment-$($binding.Tg)" --query 'TargetGroups[0].TargetGroupArn' --output text)".Trim()
    if (-not $tg -or $tg -eq 'None') { Write-Host "Target group $($binding.Tg) inexistente: se omite"; continue }
    $registered = @("$(aws elbv2 describe-target-health --target-group-arn $tg --query 'TargetHealthDescriptions[].Target.Id' --output text)".Trim() -split '\s+' | Where-Object { $_ -and $_ -ne 'None' })
    foreach ($ip in $nodeIps) {
        if ($registered -notcontains $ip) { Invoke-Native aws @('elbv2', 'register-targets', '--target-group-arn', $tg, '--targets', "Id=$ip,Port=$($binding.Port)") }
    }
    foreach ($ip in $registered) {
        if ($nodeIps -notcontains $ip) { Invoke-Native aws @('elbv2', 'deregister-targets', '--target-group-arn', $tg, '--targets', "Id=$ip,Port=$($binding.Port)") }
    }
}

Write-Summary (@(
        "## Kubernetes ``aegisvolt-$Environment``", '',
        "NLB targets: $($nodeIps -join ', ') : 30080 (graphql) y 30081 (frontend)",
        "UI del ambiente: $($peers[$Environment])/", ''
    ) + $rows)
