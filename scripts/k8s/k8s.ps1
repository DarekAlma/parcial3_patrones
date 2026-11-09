# Utilidades de Kubernetes/ECR compartidas por deploy.ps1 y canary-deploy.ps1.
. "$PSScriptRoot\..\ci\common.ps1"
. "$PSScriptRoot\..\ci\services.ps1"

$script:Namespace = 'aegisvolt'

# ---------------------------------------------------------------------------
# kubeconfig por ambiente (cluster EKS aegisvolt-<env>)
# 1) Camino estandar: aws eks update-kubeconfig (token IAM via aws eks get-token).
# 2) Floci: si el webhook de autenticacion del k3s no valida el token (p. ej.
#    tras reiniciar Floci), se usa el kubeconfig de administrador del propio
#    k3s apuntando al endpoint que publica EKS. En AWS real solo existe (1).
# ---------------------------------------------------------------------------
function Get-Kubeconfig {
    param([Parameter(Mandatory)][string]$Environment)
    $cluster = "aegisvolt-$Environment"
    $dir = Join-Path $env:USERPROFILE '.kube'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $path = Join-Path $dir "$cluster.yaml"

    Invoke-Native aws @('eks', 'update-kubeconfig', '--name', $cluster, '--kubeconfig', $path, '--alias', $cluster) | Out-Null
    if (Test-NativeSuccess kubectl @('--kubeconfig', $path, 'get', '--raw', '/readyz')) {
        Write-Host "kubeconfig ${cluster}: token IAM (aws eks get-token)"
        return $path
    }

    Write-Host "kubeconfig ${cluster}: token IAM rechazado por el k3s de Floci, usando credencial de administrador del cluster"
    $endpoint = (aws eks describe-cluster --name $cluster --query cluster.endpoint --output text).Trim()
    $container = (docker ps --filter "name=eks-$cluster" --format '{{.Names}}' | Select-Object -First 1)
    if (-not $container) { throw "No se encontro el contenedor k3s del cluster $cluster" }
    $raw = (docker exec $container cat /etc/rancher/k3s/k3s.yaml) -join "`n"
    $raw = $raw -replace 'https://127\.0\.0\.1:6443', $endpoint
    # Renombra contexto/cluster/usuario "default" (incluye las lineas "- name: default").
    $raw = $raw -replace '(?m)^(\s*(-\s*)?(name|cluster|user|current-context)):\s*default\s*$', "`$1: $cluster"
    [IO.File]::WriteAllText($path, $raw)
    if (-not (Test-NativeSuccess kubectl @('--kubeconfig', $path, 'get', '--raw', '/readyz'))) {
        throw "No se pudo conectar al cluster $cluster ($endpoint)"
    }
    return $path
}

function Invoke-Kubectl {
    param([Parameter(Mandatory)][string]$Kubeconfig, [Parameter(Mandatory)][string[]]$Arguments)
    Invoke-Native kubectl (@('--kubeconfig', $Kubeconfig, '-n', $script:Namespace) + $Arguments)
}

function Get-KubectlOutput {
    param([Parameter(Mandatory)][string]$Kubeconfig, [Parameter(Mandatory)][string[]]$Arguments)
    $ErrorActionPreference = 'Continue'
    $out = & kubectl (@('--kubeconfig', $Kubeconfig, '-n', $script:Namespace) + $Arguments) 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return ($out -join "`n").Trim()
}

# ---------------------------------------------------------------------------
# Tag de imagen = hash del CONTENIDO que compone el servicio (codigo del
# servicio + paquete common + Dockerfile + lockfile). Mismo codigo => mismo
# tag en dev, test y prod; un servicio sin cambios no genera canary.
# ---------------------------------------------------------------------------
function Get-ServiceImageTag {
    param([Parameter(Mandatory)][string]$Name)
    $svc = Get-AegisService $Name
    $inputs = @($svc.Dir, 'packages/common', 'docker/node-service.Dockerfile', 'package-lock.json') | ForEach-Object {
        (git -C $RepoRoot rev-parse "HEAD:$_").Trim()
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($inputs -join '|'))
    $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    return 'v-' + (($hash | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 12)
}

function Get-RepositoryUrl {
    param([Parameter(Mandatory)][string]$Environment, [Parameter(Mandatory)][string]$Name)
    return (aws ecr describe-repositories --repository-names "aegisvolt-$Environment/$Name" `
            --query 'repositories[0].repositoryUri' --output text).Trim()
}

# Construye y sube la imagen a ECR solo si ese tag no existe (repos IMMUTABLE).
function Publish-ServiceImage {
    param([Parameter(Mandatory)][string]$Environment, [Parameter(Mandatory)][string]$Name)
    $tag = Get-ServiceImageTag $Name
    $repo = Get-RepositoryUrl -Environment $Environment -Name $Name
    $image = "${repo}:$tag"
    if (Test-NativeSuccess aws @('ecr', 'describe-images', '--repository-name', "aegisvolt-$Environment/$Name", '--image-ids', "imageTag=$tag")) {
        Write-Host "Imagen ya publicada: $image"
        return $image
    }
    Build-ServiceImage -Name $Name -Tag $image -Version $tag | Out-Host
    Invoke-Native docker @('push', $image) | Out-Null
    Write-Host "Imagen publicada: $image"
    return $image
}

function Get-DeployedImage {
    param([Parameter(Mandatory)][string]$Kubeconfig, [Parameter(Mandatory)][string]$Deployment)
    $img = Get-KubectlOutput -Kubeconfig $Kubeconfig -Arguments @('get', 'deployment', $Deployment, '-o', 'jsonpath={.spec.template.spec.containers[0].image}')
    if (-not $img -or $img -match '^aegisvolt/.+:(STABLE|CANARY)$') { return $null }
    return $img
}

function Write-Summary([string[]]$Lines) {
    if ($env:GITHUB_STEP_SUMMARY) { $Lines | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8 }
    $Lines | ForEach-Object { Write-Host $_ }
}
