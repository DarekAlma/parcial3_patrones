# Rastrea una SAGA en CloudWatch Logs por su correlation_id (= sagaId) a traves
# de los 4 log groups del ambiente, con una consulta de Logs Insights.
#
#   .\scripts\demo\trace-saga.ps1 -Environment dev -SagaId saga-1234...
#   .\scripts\demo\trace-saga.ps1 -Environment dev -LastFailed     # ultima SAGA compensada/fallida
param(
    [string]$Environment = 'dev',
    [string]$SagaId,
    [switch]$LastFailed
)
. "$PSScriptRoot\..\ci\common.ps1"
Assert-Environment $Environment
Set-FlociEnvironment

if ($LastFailed -or -not $SagaId) {
    $json = aws dynamodb scan --table-name "aegisvolt-saga-$Environment" `
        --filter-expression '#s IN (:c, :f)' --expression-attribute-names '{\"#s\":\"status\"}' `
        --expression-attribute-values '{\":c\":{\"S\":\"COMPENSATED\"},\":f\":{\"S\":\"FAILED\"}}' --output json
    $items = (($json -join "`n") | ConvertFrom-Json).Items | Sort-Object { $_.createdAt.S } -Descending
    if (-not $items) { throw "No hay SAGAs compensadas/fallidas en $Environment" }
    $SagaId = $items[0].sagaId.S
}

$groups = 'graphql-gateway', 'station-reservation-service', 'billing-wallet-service', 'energy-dispatch-service' |
    ForEach-Object { "/aegisvolt/$Environment/$_" }
$query = "fields @timestamp, service, level, event, message | filter correlation_id = '$SagaId' | sort @timestamp asc | limit 200"
$start = [DateTimeOffset]::UtcNow.AddDays(-1).ToUnixTimeSeconds()
$end = [DateTimeOffset]::UtcNow.AddMinutes(5).ToUnixTimeSeconds()

Write-Host "Logs Insights sobre $($groups.Count) log groups de $Environment"
Write-Host "  $query"
$queryId = (aws logs start-query --log-group-names $groups --start-time $start --end-time $end --query-string $query --query queryId --output text).Trim()
do {
    Start-Sleep -Milliseconds 500
    $res = ((aws logs get-query-results --query-id $queryId --output json) -join "`n") | ConvertFrom-Json
} while ($res.status -in @('Scheduled', 'Running'))

$rows = foreach ($r in $res.results) {
    $o = [ordered]@{}
    foreach ($f in $r) { if ($f.field -ne '@ptr') { $o[$f.field] = $f.value } }
    [pscustomobject]$o
}
Write-Host ""
Write-Host "correlation_id = $SagaId  ($(@($rows).Count) eventos)"
$rows | Format-Table @{ n = 'hora'; e = { ([datetime]$_.'@timestamp').ToString('HH:mm:ss.fff') } }, service, level, event, message -AutoSize
