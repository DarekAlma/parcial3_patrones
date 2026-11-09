import { describe, expect, it } from 'vitest';
import { createMemoryLogger, RemoteError } from '@aegisvolt/common';
import { SagaEngine, type SagaStep } from '../src/saga/engine.js';
import { InMemorySagaStore } from '../src/saga/store.js';

type Data = { calls: string[] } & Record<string, unknown>;

const fast = { compensationAttempts: 3, retriableAttempts: 3, backoffMs: 1 };

function steps(opts: { failAt?: string; compensationFailures?: Record<string, number>; retriableFailures?: number } = {}) {
  const compFailures = { ...(opts.compensationFailures ?? {}) };
  let retriableFailures = opts.retriableFailures ?? 0;
  const make = (name: string, kind: SagaStep<Data>['kind'], statusAfter?: 'RESERVED' | 'CHARGED'): SagaStep<Data> => ({
    name,
    kind,
    async execute({ data }) {
      data.calls.push(`do:${name}`);
      if (kind === 'retriable' && retriableFailures > 0) {
        retriableFailures--;
        throw new Error('transient');
      }
      if (opts.failAt === name) throw new RemoteError('svc', 422, `${name}_FAILED`, `${name} fallo`, false);
      return { statusAfter, detail: { ok: true } };
    },
    compensate:
      kind === 'compensable'
        ? async ({ data }) => {
            data.calls.push(`undo:${name}`);
            if ((compFailures[name] ?? 0) > 0) {
              compFailures[name]!--;
              throw new Error('compensation transient error');
            }
            return `${name}_UNDONE`;
          }
        : undefined,
  });
  return [
    make('RESERVE', 'compensable', 'RESERVED'),
    make('CHARGE', 'compensable', 'CHARGED'),
    make('ACTIVATE', 'pivot'),
    make('CONFIRM', 'retriable'),
  ];
}

function setup() {
  const store = new InMemorySagaStore();
  const { logger, entries } = createMemoryLogger();
  const engine = new SagaEngine(store, logger, fast);
  return { store, engine, entries };
}

const run = (engine: SagaEngine, sagaId: string, s: SagaStep<Data>[], data: Data = { calls: [] }) =>
  engine.run(sagaId, 'TEST', 'dev', {}, s, data).then((r) => ({ record: r, data }));

describe('SagaEngine - orquestacion', () => {
  it('completa la SAGA cuando todos los pasos tienen exito', async () => {
    const { engine, store } = setup();
    const { record, data } = await run(engine, 'saga-ok', steps());

    expect(record.status).toBe('COMPLETED');
    expect(data.calls).toEqual(['do:RESERVE', 'do:CHARGE', 'do:ACTIVATE', 'do:CONFIRM']);
    expect(record.steps.every((s) => s.status === 'SUCCEEDED')).toBe(true);
    expect(record.compensations).toEqual([]);
    expect(store.history).toEqual(['STARTED', 'RESERVED', 'CHARGED', 'COMPLETED']);
  });

  it('falla el paso 3 (pivot): reembolsa y LUEGO libera la bahia (orden inverso)', async () => {
    const { engine, store } = setup();
    const { record, data } = await run(engine, 'saga-fault', steps({ failAt: 'ACTIVATE' }));

    expect(record.status).toBe('COMPENSATED');
    expect(data.calls).toEqual(['do:RESERVE', 'do:CHARGE', 'do:ACTIVATE', 'undo:CHARGE', 'undo:RESERVE']);
    expect(record.compensations.map((c) => c.step)).toEqual(['CHARGE', 'RESERVE']);
    expect(record.compensations.every((c) => c.status === 'SUCCEEDED')).toBe(true);
    expect(record.error).toMatchObject({ step: 'ACTIVATE', code: 'ACTIVATE_FAILED' });
    expect(record.steps.map((s) => s.status)).toEqual(['COMPENSATED', 'COMPENSATED', 'FAILED', 'PENDING']);
    expect(store.history).toEqual(['STARTED', 'RESERVED', 'CHARGED', 'COMPENSATING', 'COMPENSATED']);
  });

  it('falla el paso 2 (fondos insuficientes): solo libera la bahia', async () => {
    const { engine } = setup();
    const { record, data } = await run(engine, 'saga-funds', steps({ failAt: 'CHARGE' }));

    expect(record.status).toBe('COMPENSATED');
    expect(data.calls).toEqual(['do:RESERVE', 'do:CHARGE', 'undo:RESERVE']);
    expect(record.compensations.map((c) => c.step)).toEqual(['RESERVE']);
  });

  it('falla el paso 1: no hay nada que compensar', async () => {
    const { engine } = setup();
    const { record, data } = await run(engine, 'saga-reserve', steps({ failAt: 'RESERVE' }));

    expect(record.status).toBe('COMPENSATED');
    expect(data.calls).toEqual(['do:RESERVE']);
    expect(record.compensations).toEqual([]);
  });

  it('reintenta una compensacion que falla transitoriamente', async () => {
    const { engine } = setup();
    const { record, data } = await run(engine, 'saga-retry', steps({ failAt: 'ACTIVATE', compensationFailures: { CHARGE: 2 } }));

    expect(record.status).toBe('COMPENSATED');
    expect(data.calls.filter((c) => c === 'undo:CHARGE')).toHaveLength(3);
    expect(record.compensations.find((c) => c.step === 'CHARGE')).toMatchObject({ status: 'SUCCEEDED', attempts: 3 });
  });

  it('marca FAILED si una compensacion se agota: queda para la auditoria', async () => {
    const { engine, entries } = setup();
    const { record } = await run(engine, 'saga-stuck', steps({ failAt: 'ACTIVATE', compensationFailures: { CHARGE: 99 } }));

    expect(record.status).toBe('FAILED');
    expect(record.steps[1]!.status).toBe('COMPENSATION_FAILED');
    // La bahia igual se libera aunque el reembolso fallara.
    expect(record.steps[0]!.status).toBe('COMPENSATED');
    expect(entries.some((e) => e.event === 'saga_failed' && e.level === 'ERROR')).toBe(true);
  });

  it('es idempotente: el mismo sagaId no ejecuta la SAGA dos veces', async () => {
    const { engine } = setup();
    const first = await run(engine, 'saga-idem', steps());
    const second = await run(engine, 'saga-idem', steps());

    expect(second.record.status).toBe('COMPLETED');
    expect(second.data.calls).toEqual([]); // ningun paso se volvio a ejecutar
    expect(second.record.createdAt).toBe(first.record.createdAt);
  });

  it('reintenta los pasos retriable (post-pivot) sin compensar', async () => {
    const { engine } = setup();
    const { record, data } = await run(engine, 'saga-confirm', steps({ retriableFailures: 2 }));

    expect(record.status).toBe('COMPLETED');
    expect(record.steps[3]).toMatchObject({ status: 'SUCCEEDED', attempts: 3 });
    expect(data.calls.some((c) => c.startsWith('undo:'))).toBe(false);
  });

  it('un retriable agotado deja la SAGA FAILED pero NO revierte el pivot', async () => {
    const { engine } = setup();
    const { record, data } = await run(engine, 'saga-confirm-fail', steps({ retriableFailures: 99 }));

    expect(record.status).toBe('FAILED');
    expect(data.calls.some((c) => c.startsWith('undo:'))).toBe(false);
  });

  it('recover() compensa una SAGA huerfana (el orquestador murio a mitad de camino)', async () => {
    const { engine, store } = setup();
    const s = steps();
    await run(engine, 'saga-orphan', s);
    // Simula un crash despues del cobro: pasos 1-2 hechos, SAGA en CHARGED.
    const record = (await store.get('saga-orphan'))!;
    record.status = 'CHARGED';
    record.steps[2]!.status = 'RUNNING';
    record.steps[3]!.status = 'PENDING';
    record.completedAt = undefined;
    await store.save(record);

    const recovered = await engine.recover('saga-orphan', s);
    expect(recovered!.status).toBe('COMPENSATED');
    expect(recovered!.compensations.map((c) => c.step)).toEqual(['CHARGE', 'RESERVE']);
    expect(recovered!.error?.code).toBe('ORPHANED_SAGA');
  });

  it('todos los logs de la SAGA llevan correlation_id = sagaId', async () => {
    const { engine, entries } = setup();
    await run(engine, 'saga-trace', steps({ failAt: 'ACTIVATE' }));

    const sagaLogs = entries.filter((e) => String(e.event).startsWith('saga_'));
    expect(sagaLogs.length).toBeGreaterThan(5);
    expect(sagaLogs.every((e) => e.correlation_id === 'saga-trace')).toBe(true);
    expect(sagaLogs.map((e) => e.event)).toContain('saga_compensated');
  });
});
