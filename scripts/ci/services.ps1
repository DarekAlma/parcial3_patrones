# Catalogo unico de microservicios (lo usan lint-build, deploy y canary).
$script:AegisServices = @(
    @{ Name = 'station-reservation-service'; Dir = 'services/station-reservation-service' },
    @{ Name = 'billing-wallet-service'; Dir = 'services/billing-wallet-service' },
    @{ Name = 'energy-dispatch-service'; Dir = 'services/energy-dispatch-service' },
    @{ Name = 'graphql-gateway'; Dir = 'graphql-gateway' }
)

function Get-AegisService([string]$Name) {
    $svc = $script:AegisServices | Where-Object { $_.Name -eq $Name }
    if (-not $svc) { throw "Servicio desconocido: $Name" }
    return $svc
}

# Construye la imagen Docker de un servicio con la receta generica.
function Build-ServiceImage {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Tag, [string]$Version = 'dev')
    $svc = Get-AegisService $Name
    Invoke-Native docker @(
        'build',
        '-f', (Join-Path $RepoRoot 'docker\node-service.Dockerfile'),
        '--build-arg', "SERVICE=$($svc.Name)",
        '--build-arg', "SERVICE_DIR=$($svc.Dir)",
        '--build-arg', "APP_VERSION=$Version",
        '-t', $Tag,
        $RepoRoot
    )
}
