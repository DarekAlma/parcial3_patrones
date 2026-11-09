import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestTables, dropTestTables, type TestTables } from '../../tests/support/floci.js';
import { gql, startInProcessStack, type InProcessStack } from '../../tests/support/stack.js';

let tables: TestTables;
let stack: InProcessStack;

beforeAll(async () => {
  tables = await createTestTables('gateway');
  stack = await startInProcessStack(tables);
});
afterAll(async () => {
  await stack?.close();
  await dropTestTables(tables);
});

describe('GraphQL gateway + servicios + DynamoDB (Floci)', () => {
  it('Query stations agrega disponibilidad de conectores', async () => {
    const data = await gql<{ stations: { id: string; availableConnectors: number; totalConnectors: number }[] }>(
      stack.gatewayUrl,
      '{ stations { id availableConnectors totalConnectors connectors { id status tier } } }',
    );
    const bog = data.stations.find((s) => s.id === 'st-bog-norte')!;
    expect(bog).toMatchObject({ availableConnectors: 4, totalConnectors: 4 });
  });

  it('Query featureFlags y Mutation setFeatureFlag (sin redeploy)', async () => {
    const before = await gql<{ featureFlags: { name: string; enabled: boolean }[] }>(stack.gatewayUrl, '{ featureFlags { name enabled } }');
    expect(before.featureFlags.map((f) => f.name)).toContain('SIMULATE_CHARGER_HARDWARE_FAULT');

    const changed = await gql<{ setFeatureFlag: { enabled: boolean; updatedBy: string } }>(
      stack.gatewayUrl,
      'mutation { setFeatureFlag(name: "ENABLE_FAST_CHARGE_BOOST", enabled: true) { enabled updatedBy } }',
    );
    expect(changed.setFeatureFlag).toEqual({ enabled: true, updatedBy: 'graphql-ui' });

    await expect(gql(stack.gatewayUrl, 'mutation { setFeatureFlag(name: "NOPE", enabled: true) { enabled } }')).rejects.toThrow(/desconocida/);
  });

  it('Mutation reserveAndActivateCharge persiste el log de la SAGA en DynamoDB', async () => {
    const data = await gql<{ reserveAndActivateCharge: { sagaId: string; status: string; steps: { name: string; status: string }[] } }>(
      stack.gatewayUrl,
      `mutation($i: ReserveChargeInput!) { reserveAndActivateCharge(input: $i) { sagaId status steps { name status } } }`,
      { i: { fleetId: 'fleet-andina', stationId: 'st-bog-norte', kwh: 20, idempotencyKey: 'int-happy-0001' } },
    );
    const tx = data.reserveAndActivateCharge;
    expect(tx).toMatchObject({ sagaId: 'saga-int-happy-0001', status: 'COMPLETED' });
    expect(tx.steps.map((s) => s.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);

    const stored = await stack.sagas.get(tx.sagaId);
    expect(stored).toMatchObject({ status: 'COMPLETED', environment: 'dev' });

    const history = await gql<{ transactions: { sagaId: string }[] }>(stack.gatewayUrl, '{ transactions(limit: 5) { sagaId } }');
    expect(history.transactions.map((t) => t.sagaId)).toContain(tx.sagaId);
  });

  it('valida la entrada (kwh fuera de rango, idempotencyKey invalida)', async () => {
    await expect(
      gql(stack.gatewayUrl, 'mutation { reserveAndActivateCharge(input: {fleetId: "f", stationId: "s", kwh: 0}) { sagaId } }'),
    ).rejects.toThrow(/kwh/);
    await expect(
      gql(stack.gatewayUrl, 'mutation { reserveAndActivateCharge(input: {fleetId: "f", stationId: "s", kwh: 5, idempotencyKey: "x"}) { sagaId } }'),
    ).rejects.toThrow(/idempotencyKey/);
  });

  it('GET /flags y /health responden', async () => {
    const flags = await (await fetch(`${stack.gatewayUrl}/flags`)).json();
    expect(flags.environment).toBe('dev');
    const health = await (await fetch(`${stack.gatewayUrl}/health`)).json();
    expect(health).toMatchObject({ status: 'ok', service: 'graphql-gateway' });
  });
});
