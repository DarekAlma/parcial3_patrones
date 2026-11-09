# DEMO (sustentacion): fabrica una SAGA HUERFANA real en un ambiente.
#
# Simula que el orquestador (graphql-gateway) murio justo despues del Paso 1:
#   1. Llama de verdad a station-reservation-service: la bahia queda RESERVED.
#   2. Escribe el log de la SAGA en estado RESERVED con updatedAt de hace 10 min
#      (como lo habria dejado el orquestador antes de caerse).
# Luego el flow de Prefect "saga-consistency-audit" la detecta como HUERFANA y
# la compensa (recoverTransaction) => la bahia vuelve a AVAILABLE.
#
#   .\scripts\demo\create-orphan-saga.ps1 -Environment dev
#   docker exec aegisvolt-prefect-prefect-observer-1 prefect deployment run "saga-consistency-audit/every-5-minutes"
param(
    [string]$Environment = 'dev',
    [string]$StationId = 'st-cdmx-vallejo',
    [string]$FleetId = 'fleet-andina'
)
. "$PSScriptRoot\..\k8s\k8s.ps1"
Assert-Environment $Environment
Set-FlociEnvironment
$kc = Get-Kubeconfig -Environment $Environment

$sagaId = "saga-orphan-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$stale = (Get-Date).ToUniversalTime().AddMinutes(-10).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')

# JS sin comillas dobles (PowerShell 5.1 las altera al pasar argumentos a kubectl).
$js = @"
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
(async () => {
  const res = await fetch('http://station-reservation-service:8080/reservations', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-correlation-id': '$sagaId' },
    body: JSON.stringify({ sagaId: '$sagaId', fleetId: '$FleetId', stationId: '$StationId' }) });
  const reservation = await res.json();
  if (!res.ok) { console.log(JSON.stringify(reservation)); process.exit(1); }
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1', endpoint: process.env.AWS_ENDPOINT_URL }));
  const step = (name, kind, status) => ({ name, kind, status, attempts: status === 'PENDING' ? 0 : 1 });
  await ddb.send(new PutCommand({ TableName: 'aegisvolt-saga-$Environment', Item: {
    pk: 'SAGA#$sagaId', sk: 'META', gsi1pk: 'SAGA', gsi1sk: '$stale#$sagaId',
    sagaId: '$sagaId', type: 'RESERVE_AND_ACTIVATE_CHARGE', status: 'RESERVED', environment: '$Environment',
    input: { fleetId: '$FleetId', stationId: '$StationId', kwh: 10, priority: false },
    data: { fleetId: '$FleetId', stationId: '$StationId', kwh: 10, priority: false, connectorId: reservation.connectorId, reservation },
    steps: [ step('PRICE_QUOTE','compensable','SUCCEEDED'), step('RESERVE_CONNECTOR','compensable','SUCCEEDED'),
             step('CHARGE_WALLET','compensable','RUNNING'), step('ACTIVATE_CHARGER','pivot','PENDING'),
             step('CONFIRM_RESERVATION','retriable','PENDING') ],
    compensations: [], createdAt: '$stale', updatedAt: '$stale', version: 3 } }));
  console.log(JSON.stringify({ sagaId: '$sagaId', connectorId: reservation.connectorId, status: 'RESERVED (huerfana)' }));
})();
"@

$out = Get-KubectlOutput -Kubeconfig $kc -Arguments @('exec', 'deployment/graphql-gateway', '--', 'node', '-e', $js)
if (-not $out) { throw 'No se pudo crear la SAGA huerfana' }
Write-Host "SAGA huerfana creada en ${Environment}: $out"
Write-Host "Conector bloqueado; ejecuta la auditoria de Prefect para que la detecte y compense."
