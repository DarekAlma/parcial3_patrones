import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryLogger, StaticFlags } from '@aegisvolt/common';
import { createTestTables, ddbDoc, dropTestTables, testConfig, type TestTables } from '../../../tests/support/floci.js';
import { buildApp } from '../src/app.js';
import { SEED_STATIONS } from '../src/domain.js';
import { ReservationRepository } from '../src/repository.js';

let tables: TestTables;
let repo: ReservationRepository;
let clock = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  tables = await createTestTables('station');
  repo = new ReservationRepository(ddbDoc(), tables.reservations, () => clock);
  await repo.seed(SEED_STATIONS);
});
afterAll(() => dropTestTables(tables));

describe('station-reservation-service + DynamoDB (Floci)', () => {
  it('el seed es idempotente', async () => {
    expect(await repo.seed(SEED_STATIONS)).toBe(0);
    const stations = await repo.listStations();
    expect(stations.map((s) => s.stationId)).toEqual(['st-bog-norte', 'st-cdmx-vallejo', 'st-med-poblado']);
  });

  it('PASO 1: reserva un conector y lo deja RESERVED con lock temporal', async () => {
    const r = await repo.reserve({ sagaId: 'saga-a', fleetId: 'f1', stationId: 'st-bog-norte' }, 300);
    expect(r).toMatchObject({ status: 'HELD', tier: 'STANDARD' });
    const station = await repo.getStation('st-bog-norte');
    const c = station!.connectors.find((x) => x.connectorId === r.connectorId)!;
    expect(c).toMatchObject({ status: 'RESERVED', reservedBy: 'saga-a' });
    expect(c.lockExpiresAt).toBe(clock + 300);
  });

  it('reintentar la reserva con el mismo sagaId devuelve la misma (idempotente)', async () => {
    const again = await repo.reserve({ sagaId: 'saga-a', fleetId: 'f1', stationId: 'st-bog-norte' }, 300);
    const original = await repo.getReservation('saga-a');
    expect(again.connectorId).toBe(original!.connectorId);
    const reserved = (await repo.getStation('st-bog-norte'))!.connectors.filter((c) => c.reservedBy === 'saga-a');
    expect(reserved).toHaveLength(1);
  });

  it('dos SAGAs concurrentes por el mismo conector: solo una lo obtiene', async () => {
    const results = await Promise.allSettled([
      repo.reserve({ sagaId: 'saga-r1', fleetId: 'f1', stationId: 'st-cdmx-vallejo', connectorId: 'c3' }, 300),
      repo.reserve({ sagaId: 'saga-r2', fleetId: 'f2', stationId: 'st-cdmx-vallejo', connectorId: 'c3' }, 300),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('COMPENSACION: libera la bahia (AVAILABLE) y es idempotente', async () => {
    const r = await repo.getReservation('saga-a');
    const first = await repo.release('saga-a', 'test');
    const second = await repo.release('saga-a', 'test');
    expect(first.outcome).toBe('RELEASED');
    expect(second.outcome).toBe('ALREADY_RELEASED');
    const c = (await repo.getStation('st-bog-norte'))!.connectors.find((x) => x.connectorId === r!.connectorId)!;
    expect(c.status).toBe('AVAILABLE');
    expect(c.reservedBy).toBeUndefined();
    expect((await repo.getReservation('saga-a'))!.status).toBe('RELEASED');
  });

  it('liberar una SAGA que nunca reservo no falla (NOTHING_TO_RELEASE)', async () => {
    expect((await repo.release('saga-never', 'test')).outcome).toBe('NOTHING_TO_RELEASE');
  });

  it('un lock vencido puede ser tomado por otra SAGA', async () => {
    await repo.reserve({ sagaId: 'saga-old', fleetId: 'f1', stationId: 'st-med-poblado', connectorId: 'c1' }, 60);
    clock += 120; // pasan 2 minutos: el lock de saga-old vencio
    const r = await repo.reserve({ sagaId: 'saga-new', fleetId: 'f2', stationId: 'st-med-poblado', connectorId: 'c1' }, 60);
    expect(r.sagaId).toBe('saga-new');
    // La compensacion tardia de saga-old NO libera el conector que ahora es de saga-new.
    await repo.release('saga-old', 'late');
    const c = (await repo.getStation('st-med-poblado'))!.connectors.find((x) => x.connectorId === 'c1')!;
    expect(c).toMatchObject({ status: 'RESERVED', reservedBy: 'saga-new' });
  });

  it('confirm y complete: RESERVED -> CHARGING -> AVAILABLE', async () => {
    const r = await repo.reserve({ sagaId: 'saga-c', fleetId: 'f1', stationId: 'st-bog-norte' }, 300);
    await repo.confirm('saga-c');
    await repo.confirm('saga-c'); // idempotente
    let c = (await repo.getStation('st-bog-norte'))!.connectors.find((x) => x.connectorId === r.connectorId)!;
    expect(c.status).toBe('CHARGING');
    await repo.complete('saga-c');
    c = (await repo.getStation('st-bog-norte'))!.connectors.find((x) => x.connectorId === r.connectorId)!;
    expect(c.status).toBe('AVAILABLE');
  });

  it('HTTP: la reserva prioritaria exige ENABLE_FAST_CHARGE_BOOST', async () => {
    const flags = new StaticFlags({ ENABLE_FAST_CHARGE_BOOST: false });
    const app = buildApp({
      config: testConfig('station-reservation-service'),
      logger: createMemoryLogger().logger,
      repo,
      flags,
      lockSeconds: 300,
      priorityLockSeconds: 600,
    });
    const body = { sagaId: 'saga-p', fleetId: 'f1', stationId: 'st-bog-norte', priority: true };
    const denied = await app.inject({ method: 'POST', url: '/reservations', payload: body });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('FEATURE_DISABLED');

    flags.set('ENABLE_FAST_CHARGE_BOOST', true);
    const ok = await app.inject({ method: 'POST', url: '/reservations', payload: body });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ tier: 'ULTRA', connectorId: 'c3' });
    await app.close();
  });
});
