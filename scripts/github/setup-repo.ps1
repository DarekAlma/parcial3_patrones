# Configura el repositorio de GitHub de AegisVolt de forma reproducible.
#   1. Crea el repo publico y sube la rama dev.
#   2. Crea test y prod a partir de dev (misma historia => promociones sin conflictos).
#   3. Define dev como rama por defecto y solo permite merge commits.
#   4. Aplica el ruleset (sin force push, sin push directo, checks obligatorios).
#   5. Crea los GitHub Environments dev, test y prod.
#   6. Exige aprobacion para workflows de PRs externos (protege el runner self-hosted).
# Requisito: gh auth login (scopes repo y workflow).
param(
    [string]$RepoName = 'parcial3_patrones',
    [ValidateSet('public', 'private')][string]$Visibility = 'public'
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root

$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) { $gh = 'C:\Program Files\GitHub CLI\gh.exe' }

function Invoke-Gh { & $gh @args; if ($LASTEXITCODE -ne 0) { throw "gh $($args -join ' ') fallo ($LASTEXITCODE)." } }
function Invoke-Git { & git.exe @args; if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') fallo ($LASTEXITCODE)." } }

$owner = (Invoke-Gh api user --jq .login).Trim()
$repo = "$owner/$RepoName"
Write-Host "Repositorio destino: $repo ($Visibility)"

# 1. Repo + rama dev
& $gh repo view $repo *> $null
if ($LASTEXITCODE -ne 0) {
    Invoke-Gh repo create $repo "--$Visibility" --description 'AegisVolt - plataforma cloud-native de gestion de carga para flotas electricas' --source . --remote origin
}
Invoke-Git push -u origin dev

# 2. test y prod nacen de dev
foreach ($branch in 'test', 'prod') {
    & git show-ref --verify --quiet "refs/heads/$branch"
    if ($LASTEXITCODE -ne 0) { Invoke-Git branch $branch dev }
    Invoke-Git push -u origin $branch
}

# 3. Rama por defecto y metodos de merge
Invoke-Gh api -X PATCH "repos/$repo" `
    -f default_branch=dev `
    -F allow_merge_commit=true -F allow_squash_merge=false -F allow_rebase_merge=false `
    -F delete_branch_on_merge=false -F allow_auto_merge=false | Out-Null

# 4. Ruleset (idempotente: actualiza si ya existe)
$rulesetFile = Join-Path $root '.github\rulesets\protected-env-branches.json'
$existing = (Invoke-Gh api "repos/$repo/rulesets" --jq '.[] | select(.name=="protected-env-branches") | .id')
if ($existing) {
    Invoke-Gh api -X PUT "repos/$repo/rulesets/$existing" --input $rulesetFile | Out-Null
    Write-Host "Ruleset actualizado (id $existing)."
} else {
    Invoke-Gh api -X POST "repos/$repo/rulesets" --input $rulesetFile | Out-Null
    Write-Host 'Ruleset creado.'
}

# 5. Environments
foreach ($envName in 'dev', 'test', 'prod') {
    Invoke-Gh api -X PUT "repos/$repo/environments/$envName" | Out-Null
    Write-Host "Environment '$envName' listo."
}

# 6. Workflows de contribuidores externos requieren aprobacion
Invoke-Gh api -X PUT "repos/$repo/actions/permissions/fork-pr-contributor-approval" -f approval_policy=all_external_contributors | Out-Null

Write-Host "Listo: https://github.com/$repo"
