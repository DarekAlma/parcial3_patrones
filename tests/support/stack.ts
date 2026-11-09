/**
 * Levanta los 4 servicios EN PROCESO (puertos efimeros) sobre tablas de prueba.
 * Lo usan las pruebas de integracion del gateway (GraphQL + DynamoDB real).
 */
import type { FastifyInstance } from 'fastify';
import { createMemoryLogger, FeatureFlagClient } from '@aegisvolt/common';
import { buildApp as buildBilling } from '../../services/billing-wallet-service/src/app.js';
import { parsePeakHours } from '../../services/billing-wallet-service/src/pricing.js';
import { SEED_WALLETS, WalletRepository } from '../../services/billing-wallet-service/src/repository.js';
import { buildApp as buildDispatch } from '../../services/energy-dispatch-service/src/app.js';
import { DispatchRepository } from '../../services/energy-dispatch-service/src/repository.js';
import { buildApp as buildStation } from '../../services/station-reservation-service/src/app.js';
import { SEED_STATIONS } from '../../services/station-reservation-service/src/domain.js';
import { ReservationRepository } from '../../services/station-reservation-service/src/repository.js';
import { buildGatewayApp } from '../../graphql-gateway/src/app.js';
import { createBackends } from '../../graphql-gateway/src/clients.js';
import { SagaEngine } from '../../graphql-gateway/src/saga/engine.js';
import { DynamoSagaStore } from '../../graphql-gateway/src/saga/store.js';
import { ddbDoc, testConfig, type TestTables } from './floci.js';

export interface InProcessStack {
  gateway: FastifyInstance;
  gatewayUrl: string;
  sagas: DynamoSagaStore;
  wallets: WalletRepository;
  reservations: ReservationRepository;
  dispatch: DispatchRepository;
  close(): Promise<void>;
}

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('sin puerto');
  return `http://127.0.0.1:${addr.port}`;
}

export async function startInProcessStack(tables: TestTables): Promise<InProcessStack> {
  const doc = ddbDoc();
  const logger = createMemoryLogger().logger;
  const flags = new FeatureFlagClient(doc, tables.flags, 0);

  const reservations = new ReservationRepository(doc, tables.reservations);
  const wallets = new WalletRepository(doc, tables.billing);
  const dispatch = new DispatchRepository(doc, tables.dispatch);
  await reservations.seed(SEED_STATIONS);
  await wallets.seed(SEED_WALLETS);

  const station = buildStation({ config: testConfig('station-reservation-service'), logger, repo: reservations, flags, lockSeconds: 300, priorityLockSeconds: 600 });
  const billing = buildBilling({ config: testConfig('billing-wallet-service'), logger, repo: wallets, flags, peakHours: parsePeakHours('7-10,17-21'), timeZone: 'America/Bogota' });
  const dispatchApp = buildDispatch({ config: testConfig('energy-dispatch-service'), logger, repo: dispatch, flags });
  const [stationUrl, billingUrl, dispatchUrl] = await Promise.all([listen(station), listen(billing), listen(dispatchApp)]);

  const sagas = new DynamoSagaStore(doc, tables.saga);
  const gateway = buildGatewayApp({
    config: testConfig('graphql-gateway'),
    logger,
    sagas,
    flags,
    backends: createBackends({ station: stationUrl, billing: billingUrl, dispatch: dispatchUrl }),
    engine: new SagaEngine(sagas, logger, { compensationAttempts: 3, retriableAttempts: 3, backoffMs: 20 }),
    flagAdminEnabled: true,
  });
  const gatewayUrl = await listen(gateway);

  return {
    gateway,
    gatewayUrl,
    sagas,
    wallets,
    reservations,
    dispatch,
    close: async () => {
      await Promise.all([gateway.close(), station.close(), billing.close(), dispatchApp.close()]);
    },
  };
}

/** POST /graphql y devuelve data (falla si hay errors). */
export async function gql<T = Record<string, unknown>>(url: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${url}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data as T;
}
