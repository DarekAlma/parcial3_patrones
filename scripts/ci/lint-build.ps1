# Job lint-build:
#   1. npm ci + ESLint + typecheck TypeScript
#   2. build (tsc -> dist) de common y los 4 servicios
#   3. validacion del esquema GraphQL (SDL, resolvers, operaciones del frontend)
#   4. terraform fmt -check + validate
#   5. docker build de las 4 imagenes
. "$PSScriptRoot\common.ps1"
. "$PSScriptRoot\services.ps1"
Set-Location $RepoRoot

if (Test-NodeWorkspace) {
    Invoke-Native npm @('ci', '--no-audit', '--no-fund')
    Invoke-Native npm @('run', 'lint')
    Invoke-Native npm @('run', 'typecheck')
    Invoke-Native npm @('run', 'build')
    Invoke-Native npm @('run', 'graphql:validate')
} else {
    Write-Host 'Sin package.json en la raiz: se omite lint/build de Node.'
}

if (Test-Path (Join-Path $RepoRoot 'frontend\package.json')) {
    Push-Location (Join-Path $RepoRoot 'frontend')
    try {
        Invoke-Native npm @('ci', '--no-audit', '--no-fund')
        Invoke-Native npm @('run', 'lint', '--if-present')
        Invoke-Native npm @('run', 'build')
    } finally { Pop-Location }
}

# Terraform: formato canonico y validacion sintactica/semantica (sin backend).
foreach ($stack in 'infra\bootstrap', 'infra\terraform') {
    $dir = Join-Path $RepoRoot $stack
    if (-not (Get-ChildItem -Path $dir -Filter *.tf -ErrorAction SilentlyContinue)) { continue }
    Push-Location $dir
    try {
        Invoke-Native terraform @('fmt', '-check', '-recursive', '-diff')
        Invoke-Native terraform @('init', '-backend=false', '-input=false', '-no-color')
        Invoke-Native terraform @('validate', '-no-color')
    } finally { Pop-Location }
}

# Imagenes Docker (la misma imagen se promueve entre ambientes).
$sha = if ($env:GITHUB_SHA) { $env:GITHUB_SHA.Substring(0, 12) } else { 'local' }
foreach ($svc in $AegisServices) {
    Build-ServiceImage -Name $svc.Name -Tag "aegisvolt/$($svc.Name):ci-$sha" -Version $sha
}
