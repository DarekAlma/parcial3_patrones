import { describe, expect, it } from 'vitest';
import { createMemoryLogger, RemoteError } from '@aegisvolt/common';
import type { Backends } from '../src/clients.js';
import { SagaEngine } from '../src/saga/engine.js';
import { reserveChargeSteps, SAGA_TYPE, type ReserveChargeData } from '../src/saga/reserve-charge-saga.js';
import { InMemorySagaStore } from '../src/saga/store.js';

/** Dobles de los 3 microservicios que registran el orden de las llamadas. */
function fakeBackends(opts: { hardwareFault?: boolean; insufficientFunds?: boolean } = {}) {
  const calls: string[] = [];
  const backends = {
    billing: {
      quote: async (kwh: number, tier: string) => {
        calls.push(`billing.quote:${tier}`);
        return { kwh, tier, amountCents: kwh * 35, priceCentsPerKwh: 35, surgeApplied: false } as never;
      },
      charge: async (body: { amountCents: number }) => {
        calls.push(`billing.charge:${body.amountCents}`);
        if (opts.insufficientFunds) throw new RemoteError('billing-wallet-service', 402, 'INSUFFICIENT_FUNDS', 'sin fondos', false);
        return { transaction: { amountCents: body.amountCents }, replayed: false } as never;
      },
      refund: async () => {
        calls.push('billing.refund');
        return { outcome: 'REFUNDED' };
      },
    },
    stations: {
      reserve: async () => {
        calls.push('stations.reserve');
        return { connectorId: 'c1', tier: 'STANDARD', powerKw: 150, status: 'HELD' } as never;
      },
      release: async () => {
        calls.push('stations.release');
        return { outcome: 'RELEASED' };
      },
      confirm: async () => {
        calls.push('stations.confirm');
        return { status: 'CONFIRMED' } as never;
      },
    },
    dispatch: {
      start: async () => {
        calls.push('dispatch.start');
        if (opts.hardwareFault) {
          throw new RemoteError('energy-dispatch-service', 422, 'CHARGER_HARDWARE_FAULT', 'error fisico', false);
        }
        return { status: 'ACTIVE', powerKw: 150 } as never;
      },
    },
  } as unknown as Backends;
  return { backends, calls };
}

async function runSaga(opts: Parameters<typeof fakeBackends>[0]) {
  const { backends, calls } = fakeBackends(opts);
  const engine = new SagaEngine(new InMemorySagaStore(), createMemoryLogger().logger, {
    compensationAttempts: 2,
    retriableAttempts: 2,
    backoffMs: 1,
  });
  const data: ReserveChargeData = { fleetId: 'fleet-andina', stationId: 'st-bog-norte', kwh: 40, priority: false };
  const record = await engine.run('saga-x', SAGA_TYPE, 'test', { ...data }, reserveChargeSteps(backends), data);
  return { record, calls };
}

describe('SAGA Reservar y Activar Carga', () => {
  it('flujo feliz: cotiza, reserva, cobra, activa y confirma', async () => {
    const { record, calls } = await runSaga({});
    expect(record.status).toBe('COMPLETED');
    expect(calls).toEqual([
      'billing.quote:STANDARD',
      'stations.reserve',
      'billing.charge:1400',
      'dispatch.start',
      'stations.confirm',
    ]);
  });

  it('SIMULATE_CHARGER_HARDWARE_FAULT: reembolso en billing y despues liberacion en station', async () => {
    const { record, calls } = await runSaga({ hardwareFault: true });
    expect(record.status).toBe('COMPENSATED');
    expect(record.error).toMatchObject({ step: 'ACTIVATE_CHARGER', code: 'CHARGER_HARDWARE_FAULT' });
    expect(calls.slice(-2)).toEqual(['billing.refund', 'stations.release']);
    expect(record.compensations.map((c) => [c.step, c.outcome])).toEqual([
      ['CHARGE_WALLET', 'REFUNDED'],
      ['RESERVE_CONNECTOR', 'RELEASED'],
    ]);
  });

  it('fondos insuficientes: se libera la bahia y NO se reembolsa (no hubo cobro)', async () => {
    const { record, calls } = await runSaga({ insufficientFunds: true });
    expect(record.status).toBe('COMPENSATED');
    expect(record.error?.code).toBe('INSUFFICIENT_FUNDS');
    expect(calls).not.toContain('billing.refund');
    expect(calls.at(-1)).toBe('stations.release');
    expect(calls).not.toContain('dispatch.start');
  });
});
