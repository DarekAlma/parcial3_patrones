# Job lint-build: lint + build del codigo, validacion del esquema GraphQL
# y construccion de las imagenes Docker de cada microservicio.
. "$PSScriptRoot\common.ps1"
Set-Location $RepoRoot

if (Test-NodeWorkspace) {
    Invoke-Native npm @('ci')
    Invoke-Native npm @('run', 'lint', '--if-present')
    Invoke-Native npm @('run', 'graphql:validate', '--if-present')
    Invoke-Native npm @('run', 'build', '--if-present')
} else {
    Write-Host 'Sin package.json en la raiz: se omite lint/build de Node.'
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

$dockerfiles = Get-ChildItem -Path services, graphql-gateway, frontend -Filter Dockerfile -Recurse -ErrorAction SilentlyContinue
if (-not $dockerfiles) { Write-Host 'Sin Dockerfiles todavia: se omite docker build.' }
foreach ($df in $dockerfiles) {
    $name = $df.Directory.Name
    Invoke-Native docker @('build', '-t', "aegisvolt/${name}:ci", '-f', $df.FullName, $RepoRoot)
}
