import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryLogger, FeatureFlagClient, ServiceClient } from '@aegisvolt/common';
import { createTestTables, ddbDoc, dropTestTables, seedFlags, testConfig, type TestTables } from '../../../tests/support/floci.js';
import { buildApp } from '../src/app.js';
import { DispatchRepository } from '../src/repository.js';
import { ChargingSimulator } from '../src/simulator.js';

let tables: TestTables;
let repo: DispatchRepository;
let app: ReturnType<typeof buildApp>;

const session = (sagaId: string) => ({
  sagaId,
  fleetId: 'fleet-andina',
  stationId: 'st-bog-norte',
  connectorId: 'c1',
  powerKw: 150,
  kwhTarget: 5,
});

beforeAll(async () => {
  tables = await createTestTables('dispatch');
  repo = new DispatchRepository(ddbDoc(), tables.dispatch);
  // Flags reales en DynamoDB con cache 0: refleja cambios al instante.
  const flags = new FeatureFlagClient(ddbDoc(), tables.flags, 0);
  app = buildApp({ config: testConfig('energy-dispatch-service'), logger: createMemoryLogger().logger, repo, flags });
});
afterAll(async () => {
  await app?.close();
  await dropTestTables(tables);
});

describe('energy-dispatch-service + DynamoDB (Floci)', () => {
  it('PASO 3: activa la sesion de carga (ACTIVE)', async () => {
    const res = await app.inject({ method: 'POST', url: '/sessions', payload: session('saga-ok') });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'ACTIVE', kwhDelivered: 0 });
    const replay = await app.inject({ method: 'POST', url: '/sessions', payload: session('saga-ok') });
    expect(replay.statusCode).toBe(200); // idempotente
  });

  it('SIMULATE_CHARGER_HARDWARE_FAULT (flag en DynamoDB) => 422 y sesion FAILED', async () => {
    await seedFlags(tables.flags, { SIMULATE_CHARGER_HARDWARE_FAULT: true });
    const res = await app.inject({ method: 'POST', url: '/sessions', payload: session('saga-fault') });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('CHARGER_HARDWARE_FAULT');
    expect((await repo.getSession('saga-fault'))!).toMatchObject({ status: 'FAILED', faultCode: 'CHARGER_HARDWARE_FAULT' });

    // Aun apagando la flag, un reintento del MISMO sagaId da el mismo resultado.
    await seedFlags(tables.flags, { SIMULATE_CHARGER_HARDWARE_FAULT: false });
    const replay = await app.inject({ method: 'POST', url: '/sessions', payload: session('saga-fault') });
    expect(replay.statusCode).toBe(422);
  });

  it('el simulador entrega energia, registra telemetria y completa la sesion', async () => {
    const stations = new ServiceClient('station-reservation-service', 'http://127.0.0.1:1'); // no disponible: solo se loguea
    const sim = new ChargingSimulator(repo, stations, createMemoryLogger().logger, 10, 3600);
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 30));
      await sim.tick();
    }
    const s = await repo.getSession('saga-ok');
    expect(s!.status).toBe('COMPLETED');
    expect(s!.kwhDelivered).toBe(5);
    const telemetry = await repo.listTelemetry('st-bog-norte', 10);
    expect(telemetry.length).toBeGreaterThan(0);
    expect(telemetry[0]).toMatchObject({ sagaId: 'saga-ok', connectorId: 'c1' });
    expect(telemetry[0]!.voltageV).toBeGreaterThan(700);
  });
});
