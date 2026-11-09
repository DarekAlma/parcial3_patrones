import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryLogger, StaticFlags } from '@aegisvolt/common';
import { createTestTables, ddbDoc, dropTestTables, testConfig, type TestTables } from '../../../tests/support/floci.js';
import { buildApp } from '../src/app.js';
import { parsePeakHours } from '../src/pricing.js';
import { SEED_WALLETS, WalletRepository } from '../src/repository.js';

let tables: TestTables;
let repo: WalletRepository;

beforeAll(async () => {
  tables = await createTestTables('billing');
  repo = new WalletRepository(ddbDoc(), tables.billing);
  await repo.seed(SEED_WALLETS);
});
afterAll(() => dropTestTables(tables));

describe('billing-wallet-service + DynamoDB (Floci)', () => {
  it('PASO 2: descuenta el saldo y registra el cobro en una sola transaccion', async () => {
    const res = await repo.charge({ sagaId: 'saga-1', fleetId: 'fleet-andina', amountCents: 1_500 });
    expect(res.replayed).toBe(false);
    expect((await repo.getWallet('fleet-andina'))!.balanceCents).toBe(48_500);
  });

  it('cobrar dos veces el mismo sagaId NO descuenta dos veces (idempotencia)', async () => {
    const res = await repo.charge({ sagaId: 'saga-1', fleetId: 'fleet-andina', amountCents: 1_500 });
    expect(res.replayed).toBe(true);
    expect((await repo.getWallet('fleet-andina'))!.balanceCents).toBe(48_500);
  });

  it('cobros concurrentes del mismo sagaId: un solo descuento', async () => {
    await Promise.allSettled([
      repo.charge({ sagaId: 'saga-par', fleetId: 'fleet-pacifico', amountCents: 1_000 }),
      repo.charge({ sagaId: 'saga-par', fleetId: 'fleet-pacifico', amountCents: 1_000 }),
      repo.charge({ sagaId: 'saga-par', fleetId: 'fleet-pacifico', amountCents: 1_000 }),
    ]);
    expect((await repo.getWallet('fleet-pacifico'))!.balanceCents).toBe(19_000);
  });

  it('fondos insuficientes => 402 INSUFFICIENT_FUNDS y el saldo no cambia', async () => {
    await expect(repo.charge({ sagaId: 'saga-poor', fleetId: 'fleet-caribe', amountCents: 9_999 })).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      status: 402,
    });
    expect((await repo.getWallet('fleet-caribe'))!.balanceCents).toBe(500);
    expect(await repo.getTransaction('fleet-caribe', 'saga-poor', 'CHARGE')).toBeNull();
  });

  it('COMPENSACION: reembolsa una sola vez aunque llegue duplicada', async () => {
    const first = await repo.refund('fleet-andina', 'saga-1', 'test');
    const second = await repo.refund('fleet-andina', 'saga-1', 'test');
    const [a, b] = await Promise.all([repo.refund('fleet-andina', 'saga-1', 'x'), repo.refund('fleet-andina', 'saga-1', 'y')]);
    expect(first.outcome).toBe('REFUNDED');
    expect([second.outcome, a.outcome, b.outcome]).toEqual(['ALREADY_REFUNDED', 'ALREADY_REFUNDED', 'ALREADY_REFUNDED']);
    expect((await repo.getWallet('fleet-andina'))!.balanceCents).toBe(50_000);
  });

  it('el reembolso queda registrado como evento de reversion', async () => {
    const txns = await repo.listTransactions('fleet-andina');
    expect(txns.map((t) => t.type).sort()).toEqual(['CHARGE', 'REFUND']);
    expect(txns.find((t) => t.type === 'REFUND')!.description).toContain('Reembolso compensatorio');
  });

  it('reembolsar algo que nunca se cobro => NOTHING_TO_REFUND', async () => {
    expect((await repo.refund('fleet-andina', 'saga-none', 'x')).outcome).toBe('NOTHING_TO_REFUND');
  });

  it('HTTP /quotes aplica surge solo con la flag activa', async () => {
    const flags = new StaticFlags({ ENABLE_DYNAMIC_SURGE_PRICING: true });
    const app = buildApp({
      config: testConfig('billing-wallet-service'),
      logger: createMemoryLogger().logger,
      repo,
      flags,
      peakHours: parsePeakHours('0-24'),
      timeZone: 'America/Bogota',
    });
    const on = await app.inject({ method: 'POST', url: '/quotes', payload: { kwh: 10, tier: 'STANDARD' } });
    expect(on.json()).toMatchObject({ surgeApplied: true, amountCents: 530 });
    flags.set('ENABLE_DYNAMIC_SURGE_PRICING', false);
    const off = await app.inject({ method: 'POST', url: '/quotes', payload: { kwh: 10, tier: 'STANDARD' } });
    expect(off.json()).toMatchObject({ surgeApplied: false, amountCents: 350 });

    const bad = await app.inject({ method: 'POST', url: '/charges', payload: { sagaId: 'x', fleetId: 'y', amountCents: -1 } });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
