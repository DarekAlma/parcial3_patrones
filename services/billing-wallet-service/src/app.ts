import type { FastifyInstance } from 'fastify';
import { createHttpServer, DomainError, FLAGS, type BaseConfig, type FlagReader, type Logger } from '@aegisvolt/common';
import { quote, type Tier } from './pricing.js';
import type { ChargeInput, WalletRepository } from './repository.js';

export interface AppDeps {
  config: BaseConfig;
  logger: Logger;
  repo: WalletRepository;
  flags: FlagReader;
  peakHours: [number, number][];
  timeZone: string;
  now?: () => Date;
  readiness?: () => Promise<void>;
}

const chargeSchema = {
  body: {
    type: 'object',
    required: ['sagaId', 'fleetId', 'amountCents'],
    additionalProperties: false,
    properties: {
      sagaId: { type: 'string', minLength: 1, maxLength: 64 },
      fleetId: { type: 'string', minLength: 1, maxLength: 64 },
      amountCents: { type: 'integer', minimum: 1, maximum: 10_000_000 },
      description: { type: 'string', maxLength: 200 },
    },
  },
} as const;

const refundSchema = {
  body: {
    type: 'object',
    required: ['fleetId'],
    properties: { fleetId: { type: 'string', minLength: 1 }, reason: { type: 'string', maxLength: 200 } },
  },
} as const;

const quoteSchema = {
  body: {
    type: 'object',
    required: ['kwh', 'tier'],
    additionalProperties: false,
    properties: { kwh: { type: 'number', exclusiveMinimum: 0, maximum: 500 }, tier: { enum: ['STANDARD', 'ULTRA'] } },
  },
} as const;

/**
 * API interna:
 *   GET  /wallets                        billeteras de las flotas
 *   GET  /wallets/:fleetId
 *   GET  /wallets/:fleetId/transactions  cobros y reembolsos
 *   POST /wallets/:fleetId/top-up        recarga (demo)
 *   POST /quotes                         cotizacion (aplica ENABLE_DYNAMIC_SURGE_PRICING)
 *   POST /charges                        PASO 2 SAGA: verificar fondos y cobrar
 *   POST /charges/:sagaId/refund         COMPENSACION: reembolso + evento de reversion
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const { repo, flags } = deps;
  const now = deps.now ?? (() => new Date());
  const app = createHttpServer({ config: deps.config, logger: deps.logger, readiness: deps.readiness });

  app.get('/wallets', async () => repo.listWallets());

  app.get<{ Params: { fleetId: string } }>('/wallets/:fleetId', async (req) => {
    const wallet = await repo.getWallet(req.params.fleetId);
    if (!wallet) throw new DomainError('WALLET_NOT_FOUND', `La flota ${req.params.fleetId} no tiene billetera`, 404);
    return wallet;
  });

  app.get<{ Params: { fleetId: string }; Querystring: { limit?: string } }>('/wallets/:fleetId/transactions', async (req) =>
    repo.listTransactions(req.params.fleetId, Math.min(Number(req.query.limit ?? 50), 200)),
  );

  app.post<{ Params: { fleetId: string }; Body: { amountCents: number } }>(
    '/wallets/:fleetId/top-up',
    { schema: { body: { type: 'object', required: ['amountCents'], properties: { amountCents: { type: 'integer', minimum: 1, maximum: 1_000_000 } } } } },
    async (req) => repo.topUp(req.params.fleetId, req.body.amountCents),
  );

  app.post<{ Body: { kwh: number; tier: Tier } }>('/quotes', { schema: quoteSchema }, async (req) => {
    const surgeEnabled = await flags.isEnabled(FLAGS.ENABLE_DYNAMIC_SURGE_PRICING);
    return quote(req.body, { surgeEnabled, now: now(), peakHours: deps.peakHours, timeZone: deps.timeZone });
  });

  app.post<{ Body: ChargeInput }>('/charges', { schema: chargeSchema }, async (req, reply) => {
    const result = await repo.charge(req.body);
    req.log2.info(result.replayed ? 'charge replayed (idempotent)' : 'wallet charged', {
      event: result.replayed ? 'charge_replayed' : 'wallet_charged',
      saga_id: req.body.sagaId,
      fleet_id: req.body.fleetId,
      amount_cents: req.body.amountCents,
    });
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  app.post<{ Params: { sagaId: string }; Body: { fleetId: string; reason?: string } }>(
    '/charges/:sagaId/refund',
    { schema: refundSchema },
    async (req) => {
      const result = await repo.refund(req.body.fleetId, req.params.sagaId, req.body.reason ?? 'saga-compensation');
      req.log2.info('refund processed', {
        event: 'wallet_refund',
        saga_id: req.params.sagaId,
        fleet_id: req.body.fleetId,
        outcome: result.outcome,
      });
      return result;
    },
  );

  return app;
}
