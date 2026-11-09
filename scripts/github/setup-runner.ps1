# Registra un GitHub Actions runner self-hosted en este PC con la etiqueta
# 'aegisvolt'. El runner ve Floci (localhost:4566), Docker y Kubernetes locales,
# por eso todos los jobs de CI/CD corren aqui.
# El runner se instala FUERA del repo (por defecto C:\actions-runner-aegisvolt).
param(
    [string]$RepoName = 'parcial3_patrones',
    [string]$RunnerDir = 'C:\actions-runner-aegisvolt',
    [string]$RunnerName = 'aegisvolt-local'
)
$ErrorActionPreference = 'Stop'

$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) { $gh = 'C:\Program Files\GitHub CLI\gh.exe' }
$owner = (& $gh api user --jq .login).Trim()
$repo = "$owner/$RepoName"

# Ultima version oficial de actions/runner (win-x64)
$release = & $gh api repos/actions/runner/releases/latest | ConvertFrom-Json
$version = $release.tag_name.TrimStart('v')
$zipName = "actions-runner-win-x64-$version.zip"
$asset = $release.assets | Where-Object name -eq $zipName
if (-not $asset) { throw "No se encontro $zipName en el release $($release.tag_name)." }

New-Item -ItemType Directory -Force -Path $RunnerDir | Out-Null
Set-Location $RunnerDir

if (-not (Test-Path '.\config.cmd')) {
    Write-Host "Descargando $zipName ..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipName
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $RunnerDir $zipName), $RunnerDir)
    Remove-Item $zipName
}

$token = (& $gh api -X POST "repos/$repo/actions/runners/registration-token" --jq .token).Trim()
.\config.cmd --unattended --replace `
    --url "https://github.com/$repo" `
    --token $token `
    --name $RunnerName `
    --labels aegisvolt `
    --work _work
if ($LASTEXITCODE -ne 0) { throw 'config.cmd fallo.' }

Write-Host ''
Write-Host "Runner registrado. Para ponerlo a escuchar jobs ejecuta:"
Write-Host "  $RunnerDir\run.cmd"
