/**
 * E2E: flujo completo "Reservar y Activar Carga" a traves de la API GraphQL,
 * con los 4 microservicios corriendo como procesos independientes sobre
 * DynamoDB (Floci). Se verifica el estado FINAL en las tablas de cada servicio
 * (Database-per-Service), igual que se demostrara en la sustentacion.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestTables, dropTestTables, type TestTables } from '../support/floci.js';
import { startProcessStack, type ProcessStack } from '../support/processes.js';
import { gql } from '../support/stack.js';
import { WalletRepository } from '../../services/billing-wallet-service/src/repository.js';
import { ReservationRepository } from '../../services/station-reservation-service/src/repository.js';
import { DispatchRepository } from '../../services/energy-dispatch-service/src/repository.js';
import { ddbDoc } from '../support/floci.js';

let tables: TestTables;
let stack: ProcessStack;
let wallets: WalletRepository;
let reservations: ReservationRepository;
let dispatch: DispatchRepository;

const RESERVE = `
  mutation Reserve($input: ReserveChargeInput!) {
    reserveAndActivateCharge(input: $input) {
      sagaId correlationId status connectorId amountCents
      error { step code message }
      steps { name kind status }
      compensations { step status outcome }
    }
  }`;

type Tx = {
  sagaId: string;
  correlationId: string;
  status: string;
  connectorId: string | null;
  amountCents: number | null;
  error: { step: string; code: string } | null;
  steps: { name: string; status: string }[];
  compensations: { step: string; status: string; outcome: string }[];
};

const reserve = async (input: Record<string, unknown>) =>
  (await gql<{ reserveAndActivateCharge: Tx }>(stack.gatewayUrl, RESERVE, { input })).reserveAndActivateCharge;

const setFlag = (name: string, enabled: boolean) =>
  gql(stack.gatewayUrl, `mutation { setFeatureFlag(name: "${name}", enabled: ${enabled}) { enabled } }`);

const connectorStatus = async (stationId: string, connectorId: string) =>
  (await reservations.getStation(stationId))!.connectors.find((c) => c.connectorId === connectorId)!.status;

beforeAll(async () => {
  tables = await createTestTables('e2e');
  stack = await startProcessStack({
    tables,
    // Cache de flags corto y simulador acelerado para que la prueba sea rapida.
    extraEnv: { FLAGS_CACHE_MS: '200', SIMULATOR_INTERVAL_MS: '300', SIMULATOR_SPEED_FACTOR: '3600', LOG_STDOUT: 'true' },
  });
  const doc = ddbDoc();
  wallets = new WalletRepository(doc, tables.billing);
  reservations = new ReservationRepository(doc, tables.reservations);
  dispatch = new DispatchRepository(doc, tables.dispatch);
});

afterAll(async () => {
  await stack?.stop();
  await dropTestTables(tables);
});

describe('E2E Reservar y Activar Carga (GraphQL -> 3 microservicios -> DynamoDB)', () => {
  it('flujo feliz: COMPLETED, bahia CHARGING, saldo descontado y telemetria registrada', async () => {
    const before = (await wallets.getWallet('fleet-andina'))!.balanceCents;
    const tx = await reserve({ fleetId: 'fleet-andina', stationId: 'st-bog-norte', kwh: 10, idempotencyKey: 'e2e-happy-0001' });

    expect(tx.status).toBe('COMPLETED');
    expect(tx.correlationId).toBe(tx.sagaId);
    expect(tx.steps.map((s) => s.status)).toEqual(Array(5).fill('SUCCEEDED'));
    expect(await connectorStatus('st-bog-norte', tx.connectorId!)).toBe('CHARGING');
    expect((await wallets.getWallet('fleet-andina'))!.balanceCents).toBe(before - tx.amountCents!);

    // El simulador completa la sesion y la bahia vuelve a AVAILABLE.
    await expect.poll(async () => (await dispatch.getSession(tx.sagaId))?.status, { timeout: 15_000, interval: 300 }).toBe('COMPLETED');
    await expect.poll(() => connectorStatus('st-bog-norte', tx.connectorId!), { timeout: 10_000, interval: 300 }).toBe('AVAILABLE');
    expect((await dispatch.listTelemetry('st-bog-norte', 50)).some((p) => p.sagaId === tx.sagaId)).toBe(true);
  });

  it('idempotencia: repetir la mutacion con la misma idempotencyKey no cobra dos veces', async () => {
    const before = (await wallets.getWallet('fleet-andina'))!.balanceCents;
    const tx = await reserve({ fleetId: 'fleet-andina', stationId: 'st-bog-norte', kwh: 10, idempotencyKey: 'e2e-happy-0001' });
    expect(tx.sagaId).toBe('saga-e2e-happy-0001');
    expect((await wallets.getWallet('fleet-andina'))!.balanceCents).toBe(before);
  });

  it('SIMULATE_CHARGER_HARDWARE_FAULT: rollback -> reembolso (billing) y luego liberacion (station)', async () => {
    await setFlag('SIMULATE_CHARGER_HARDWARE_FAULT', true);
    await new Promise((r) => setTimeout(r, 400)); // > FLAGS_CACHE_MS
    const before = (await wallets.getWallet('fleet-pacifico'))!.balanceCents;

    const tx = await reserve({ fleetId: 'fleet-pacifico', stationId: 'st-cdmx-vallejo', kwh: 15 });
    await setFlag('SIMULATE_CHARGER_HARDWARE_FAULT', false);

    expect(tx.status).toBe('COMPENSATED');
    expect(tx.error).toMatchObject({ step: 'ACTIVATE_CHARGER', code: 'CHARGER_HARDWARE_FAULT' });
    expect(tx.compensations).toEqual([
      { step: 'CHARGE_WALLET', status: 'SUCCEEDED', outcome: 'REFUNDED' },
      { step: 'RESERVE_CONNECTOR', status: 'SUCCEEDED', outcome: 'RELEASED' },
    ]);

    // Estado final en cada tabla:
    expect((await wallets.getWallet('fleet-pacifico'))!.balanceCents).toBe(before);
    const txns = await wallets.listTransactions('fleet-pacifico');
    expect(txns.filter((t) => t.sagaId === tx.sagaId).map((t) => t.type).sort()).toEqual(['CHARGE', 'REFUND']);
    expect((await reservations.getReservation(tx.sagaId))!.status).toBe('RELEASED');
    expect(await connectorStatus('st-cdmx-vallejo', tx.connectorId!)).toBe('AVAILABLE');
    expect((await dispatch.getSession(tx.sagaId))!).toMatchObject({ status: 'FAILED', faultCode: 'CHARGER_HARDWARE_FAULT' });
  });

  it('fondos insuficientes: libera la bahia inmediatamente y no hay reembolso', async () => {
    const tx = await reserve({ fleetId: 'fleet-caribe', stationId: 'st-med-poblado', kwh: 100 });

    expect(tx.status).toBe('COMPENSATED');
    expect(tx.error).toMatchObject({ step: 'CHARGE_WALLET', code: 'INSUFFICIENT_FUNDS' });
    expect(tx.compensations).toEqual([{ step: 'RESERVE_CONNECTOR', status: 'SUCCEEDED', outcome: 'RELEASED' }]);
    expect((await wallets.getWallet('fleet-caribe'))!.balanceCents).toBe(500);
    expect(await connectorStatus('st-med-poblado', tx.connectorId!)).toBe('AVAILABLE');
  });

  it('ENABLE_FAST_CHARGE_BOOST: la reserva prioritaria se rechaza con la flag apagada y usa ULTRA con la flag activa', async () => {
    await setFlag('ENABLE_FAST_CHARGE_BOOST', false);
    await new Promise((r) => setTimeout(r, 400));
    const denied = await reserve({ fleetId: 'fleet-andina', stationId: 'st-bog-norte', kwh: 5, priority: true });
    expect(denied.status).toBe('COMPENSATED');
    expect(denied.error).toMatchObject({ step: 'RESERVE_CONNECTOR', code: 'FEATURE_DISABLED' });

    await setFlag('ENABLE_FAST_CHARGE_BOOST', true);
    await new Promise((r) => setTimeout(r, 400));
    const ok = await reserve({ fleetId: 'fleet-andina', stationId: 'st-bog-norte', kwh: 5, priority: true });
    expect(ok.status).toBe('COMPLETED');
    expect(ok.connectorId).toBe('c3'); // conector ULTRA de 350 kW
  });

  it('el historial muestra las transacciones con su estado de compensacion', async () => {
    const data = await gql<{ transactions: { status: string }[] }>(stack.gatewayUrl, '{ transactions(limit: 20) { status } }');
    const statuses = data.transactions.map((t) => t.status);
    expect(statuses).toContain('COMPLETED');
    expect(statuses).toContain('COMPENSATED');
  });

  it('los logs de los 4 servicios comparten el correlation_id de la SAGA', async () => {
    const tx = await reserve({ fleetId: 'fleet-andina', stationId: 'st-med-poblado', kwh: 3 });
    await new Promise((r) => setTimeout(r, 300));
    for (const svc of ['graphql-gateway', 'station-reservation-service', 'billing-wallet-service', 'energy-dispatch-service']) {
      const lines = stack.logs[svc]!.join('').split('\n').filter(Boolean);
      expect(lines.some((l) => l.includes(`"correlation_id":"${tx.sagaId}"`))).toBe(true);
    }
  });
});
