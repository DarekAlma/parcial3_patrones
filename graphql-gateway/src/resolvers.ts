import { randomUUID } from 'node:crypto';
import { createGraphQLError } from 'graphql-yoga';
import type { BaseConfig, FeatureFlagClient, Logger } from '@aegisvolt/common';
import type { Backends, Connector, Station, Wallet } from './clients.js';
import type { SagaEngine } from './saga/engine.js';
import { reserveChargeSteps, SAGA_TYPE, type ReserveChargeData } from './saga/reserve-charge-saga.js';
import type { DynamoSagaStore } from './saga/store.js';
import type { SagaRecord, SagaStatus } from './saga/types.js';

export interface GatewayContext {
  correlationId: string;
}

export interface ResolverDeps {
  config: BaseConfig;
  logger: Logger;
  backends: Backends;
  flags: FeatureFlagClient;
  engine: SagaEngine;
  sagas: DynamoSagaStore;
  flagAdminEnabled: boolean;
}

interface ReserveChargeInput {
  fleetId: string;
  stationId: string;
  connectorId?: string | null;
  kwh: number;
  priority?: boolean | null;
  idempotencyKey?: string | null;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;

/** Mapea el log de la SAGA al tipo GraphQL ChargeTransaction. */
export function toTransaction(record: SagaRecord) {
  const data = record.data as Partial<ReserveChargeData>;
  const input = record.input as Partial<ReserveChargeData>;
  return {
    sagaId: record.sagaId,
    correlationId: record.sagaId,
    type: record.type,
    status: record.status,
    environment: record.environment,
    fleetId: input.fleetId,
    stationId: input.stationId,
    connectorId: data.connectorId ?? input.connectorId ?? null,
    priority: Boolean(input.priority),
    kwh: input.kwh,
    amountCents: data.quote?.amountCents ?? null,
    quote: data.quote ?? null,
    steps: record.steps.map((s) => ({ ...s, detail: s.detail ? JSON.stringify(s.detail) : null })),
    compensations: record.compensations,
    error: record.error ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt ?? null,
    durationMs: record.completedAt ? new Date(record.completedAt).getTime() - new Date(record.createdAt).getTime() : null,
  };
}

function toStation(s: Station) {
  return {
    id: s.stationId,
    name: s.name,
    city: s.city,
    country: s.country,
    lat: s.lat,
    lng: s.lng,
    connectors: s.connectors.map(toConnector),
    availableConnectors: s.connectors.filter((c) => c.status === 'AVAILABLE').length,
    totalConnectors: s.connectors.length,
  };
}

function toConnector(c: Connector) {
  return { ...c, id: c.connectorId };
}

export function createResolvers(deps: ResolverDeps) {
  const { backends, flags, engine, sagas, config } = deps;
  const steps = reserveChargeSteps(backends);
  const o = (ctx: GatewayContext) => ({ correlationId: ctx.correlationId });

  return {
    Query: {
      environment: () => ({
        environment: config.environment,
        service: config.service,
        version: config.version,
        track: config.track,
        flagAdminEnabled: deps.flagAdminEnabled,
      }),
      featureFlags: async () => (await flags.list()).map((f) => ({ ...f, name: f.flag })),
      stations: async (_: unknown, __: unknown, ctx: GatewayContext) => (await backends.stations.listStations(o(ctx))).map(toStation),
      station: async (_: unknown, args: { id: string }, ctx: GatewayContext) => {
        try {
          return toStation(await backends.stations.getStation(args.id, o(ctx)));
        } catch (err) {
          if ((err as { status?: number }).status === 404) return null;
          throw err;
        }
      },
      telemetry: (_: unknown, args: { stationId: string; limit: number }, ctx: GatewayContext) =>
        backends.dispatch.telemetry(args.stationId, Math.min(args.limit, 200), o(ctx)),
      chargingSessions: (_: unknown, args: { status?: string }, ctx: GatewayContext) =>
        backends.dispatch.sessions(args.status, o(ctx)),
      wallets: (_: unknown, __: unknown, ctx: GatewayContext) => backends.billing.listWallets(o(ctx)),
      wallet: async (_: unknown, args: { fleetId: string }, ctx: GatewayContext) => {
        try {
          return await backends.billing.getWallet(args.fleetId, o(ctx));
        } catch (err) {
          if ((err as { status?: number }).status === 404) return null;
          throw err;
        }
      },
      quote: (_: unknown, args: { kwh: number; priority: boolean }, ctx: GatewayContext) =>
        backends.billing.quote(args.kwh, args.priority ? 'ULTRA' : 'STANDARD', o(ctx)),
      transactions: async (_: unknown, args: { limit: number; status?: SagaStatus }) =>
        (await sagas.list(Math.min(args.limit, 100), args.status)).map(toTransaction),
      transaction: async (_: unknown, args: { sagaId: string }) => {
        const record = await sagas.get(args.sagaId);
        return record ? toTransaction(record) : null;
      },
    },

    Wallet: {
      transactions: (wallet: Wallet, args: { limit: number }, ctx: GatewayContext) =>
        backends.billing.transactions(wallet.fleetId, Math.min(args.limit, 100), o(ctx)),
    },

    Mutation: {
      reserveAndActivateCharge: async (_: unknown, { input }: { input: ReserveChargeInput }) => {
        if (!(input.kwh > 0 && input.kwh <= 500)) {
          throw createGraphQLError('kwh debe estar entre 0 y 500', { extensions: { code: 'BAD_USER_INPUT' } });
        }
        if (input.idempotencyKey && !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
          throw createGraphQLError('idempotencyKey invalida (8-64 caracteres [A-Za-z0-9_-])', { extensions: { code: 'BAD_USER_INPUT' } });
        }
        // El sagaId ES el correlation_id que se propaga a los 3 servicios y a CloudWatch.
        const sagaId = input.idempotencyKey ? `saga-${input.idempotencyKey}` : `saga-${randomUUID()}`;
        const data: ReserveChargeData = {
          fleetId: input.fleetId,
          stationId: input.stationId,
          connectorId: input.connectorId ?? undefined,
          kwh: input.kwh,
          priority: Boolean(input.priority),
        };
        const record = await engine.run(sagaId, SAGA_TYPE, config.environment, { ...data }, steps, data);
        return toTransaction(record);
      },

      setFeatureFlag: async (_: unknown, args: { name: string; enabled: boolean }) => {
        if (!deps.flagAdminEnabled) {
          throw createGraphQLError(`La administracion de flags esta deshabilitada en ${config.environment}`, {
            extensions: { code: 'FORBIDDEN' },
          });
        }
        try {
          const flag = await flags.set(args.name, args.enabled, 'graphql-ui', config.environment);
          deps.logger.info('feature flag changed', { event: 'feature_flag_changed', flag: args.name, enabled: args.enabled });
          return { ...flag, name: flag.flag };
        } catch (err) {
          throw createGraphQLError((err as Error).message, { extensions: { code: 'BAD_USER_INPUT' } });
        }
      },

      recoverTransaction: async (_: unknown, args: { sagaId: string }) => {
        const record = await engine.recover(args.sagaId, steps);
        return record ? toTransaction(record) : null;
      },

      topUpWallet: (_: unknown, args: { fleetId: string; amountCents: number }, ctx: GatewayContext) =>
        backends.billing.topUp(args.fleetId, args.amountCents, o(ctx)),
    },
  };
}
