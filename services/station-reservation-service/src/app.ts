import type { FastifyInstance } from 'fastify';
import { createHttpServer, DomainError, FLAGS, type BaseConfig, type FlagReader, type Logger } from '@aegisvolt/common';
import type { ReserveInput } from './domain.js';
import type { ReservationRepository } from './repository.js';

export interface AppDeps {
  config: BaseConfig;
  logger: Logger;
  repo: ReservationRepository;
  flags: FlagReader;
  lockSeconds: number;
  priorityLockSeconds: number;
  readiness?: () => Promise<void>;
}

const reserveSchema = {
  body: {
    type: 'object',
    required: ['sagaId', 'fleetId', 'stationId'],
    additionalProperties: false,
    properties: {
      sagaId: { type: 'string', minLength: 1, maxLength: 64 },
      fleetId: { type: 'string', minLength: 1, maxLength: 64 },
      stationId: { type: 'string', minLength: 1, maxLength: 64 },
      connectorId: { type: 'string', minLength: 1, maxLength: 16 },
      priority: { type: 'boolean' },
    },
  },
} as const;

const releaseSchema = {
  body: {
    type: 'object',
    properties: { reason: { type: 'string', maxLength: 200 } },
  },
} as const;

/**
 * API interna (solo accesible dentro del cluster):
 *   GET  /stations                     estado de electrolineras y conectores
 *   GET  /stations/:stationId
 *   POST /reservations                 PASO 1 SAGA: bloquear bahia (RESERVED)
 *   GET  /reservations/:sagaId
 *   POST /reservations/:sagaId/release COMPENSACION: liberar bahia (AVAILABLE)
 *   POST /reservations/:sagaId/confirm carga activada: RESERVED -> CHARGING
 *   POST /reservations/:sagaId/complete fin de la sesion: CHARGING -> AVAILABLE
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const { repo, flags } = deps;
  const app = createHttpServer({ config: deps.config, logger: deps.logger, readiness: deps.readiness });

  app.get('/stations', async () => repo.listStations());

  app.get<{ Params: { stationId: string } }>('/stations/:stationId', async (req) => {
    const station = await repo.getStation(req.params.stationId);
    if (!station) throw new DomainError('STATION_NOT_FOUND', `Estacion ${req.params.stationId} no existe`, 404);
    return station;
  });

  app.post<{ Body: ReserveInput }>('/reservations', { schema: reserveSchema }, async (req, reply) => {
    const input = req.body;
    if (input.priority && !(await flags.isEnabled(FLAGS.ENABLE_FAST_CHARGE_BOOST))) {
      throw new DomainError(
        'FEATURE_DISABLED',
        'La reserva prioritaria de ultra-carga (ENABLE_FAST_CHARGE_BOOST) esta desactivada en este ambiente',
        403,
      );
    }
    const lock = input.priority ? deps.priorityLockSeconds : deps.lockSeconds;
    const reservation = await repo.reserve(input, lock);
    req.log2.info('connector reserved', {
      event: 'reservation_held',
      saga_id: input.sagaId,
      station_id: reservation.stationId,
      connector_id: reservation.connectorId,
      tier: reservation.tier,
    });
    return reply.status(201).send(reservation);
  });

  app.get<{ Params: { sagaId: string } }>('/reservations/:sagaId', async (req) => {
    const reservation = await repo.getReservation(req.params.sagaId);
    if (!reservation) throw new DomainError('RESERVATION_NOT_FOUND', `Reserva ${req.params.sagaId} no existe`, 404);
    return reservation;
  });

  app.post<{ Params: { sagaId: string }; Body: { reason?: string } }>(
    '/reservations/:sagaId/release',
    { schema: releaseSchema },
    async (req) => {
      const result = await repo.release(req.params.sagaId, req.body?.reason ?? 'saga-compensation');
      req.log2.info('reservation release processed', {
        event: 'reservation_released',
        saga_id: req.params.sagaId,
        outcome: result.outcome,
      });
      return result;
    },
  );

  app.post<{ Params: { sagaId: string } }>('/reservations/:sagaId/confirm', async (req) => {
    const reservation = await repo.confirm(req.params.sagaId);
    req.log2.info('reservation confirmed', { event: 'reservation_confirmed', saga_id: req.params.sagaId });
    return reservation;
  });

  app.post<{ Params: { sagaId: string } }>('/reservations/:sagaId/complete', async (req) => {
    const reservation = await repo.complete(req.params.sagaId);
    req.log2.info('reservation completed', { event: 'reservation_completed', saga_id: req.params.sagaId });
    return reservation;
  });

  return app;
}
