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

# 4. Targets del NLB: nodos del cluster en el NodePort del gateway
$tg = (aws elbv2 describe-target-groups --names "aegisvolt-$Environment-tg-graphql" --query 'TargetGroups[0].TargetGroupArn' --output text).Trim()
# "$(...)": una salida vacia de un comando nativo es AutomationNull y no admite .Trim().
$nodeIps = @("$(kubectl --kubeconfig $kc get nodes -o "jsonpath={.items[*].status.addresses[?(@.type=='InternalIP')].address}")".Trim() -split '\s+' | Where-Object { $_ })
$registered = @("$(aws elbv2 describe-target-health --target-group-arn $tg --query 'TargetHealthDescriptions[].Target.Id' --output text)".Trim() -split '\s+' | Where-Object { $_ -and $_ -ne 'None' })
if (-not $nodeIps) { throw 'No se pudieron obtener las IPs de los nodos del cluster' }
foreach ($ip in $nodeIps) {
    if ($registered -notcontains $ip) { Invoke-Native aws @('elbv2', 'register-targets', '--target-group-arn', $tg, '--targets', "Id=$ip,Port=30080") }
}
foreach ($ip in $registered) {
    if ($nodeIps -notcontains $ip) { Invoke-Native aws @('elbv2', 'deregister-targets', '--target-group-arn', $tg, '--targets', "Id=$ip,Port=30080") }
}

Write-Summary (@("## Kubernetes ``aegisvolt-$Environment``", '', "NLB targets: $($nodeIps -join ', ') : 30080", '') + $rows)
