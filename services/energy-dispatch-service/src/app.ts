import type { FastifyInstance } from 'fastify';
import { createHttpServer, DomainError, FLAGS, type BaseConfig, type FlagReader, type Logger } from '@aegisvolt/common';
import type { DispatchRepository, SessionStatus, StartSessionInput } from './repository.js';

export interface AppDeps {
  config: BaseConfig;
  logger: Logger;
  repo: DispatchRepository;
  flags: FlagReader;
  readiness?: () => Promise<void>;
}

const startSchema = {
  body: {
    type: 'object',
    required: ['sagaId', 'fleetId', 'stationId', 'connectorId', 'powerKw', 'kwhTarget'],
    additionalProperties: false,
    properties: {
      sagaId: { type: 'string', minLength: 1, maxLength: 64 },
      fleetId: { type: 'string', minLength: 1, maxLength: 64 },
      stationId: { type: 'string', minLength: 1, maxLength: 64 },
      connectorId: { type: 'string', minLength: 1, maxLength: 16 },
      powerKw: { type: 'number', exclusiveMinimum: 0, maximum: 1000 },
      kwhTarget: { type: 'number', exclusiveMinimum: 0, maximum: 500 },
    },
  },
} as const;

export const HARDWARE_FAULT = 'CHARGER_HARDWARE_FAULT';

/**
 * API interna:
 *   POST /sessions               PASO 3 SAGA: orden de activacion fisica del cargador
 *   GET  /sessions[?status=]     sesiones de carga
 *   GET  /sessions/:sagaId
 *   GET  /telemetry/:stationId   ultimos puntos de telemetria de la estacion
 *
 * SIMULATE_CHARGER_HARDWARE_FAULT: el cargador "reporta" un error fisico; la
 * sesion queda FAILED y se responde 422 CHARGER_HARDWARE_FAULT, lo que dispara
 * el rollback de la SAGA en el orquestador.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const { repo, flags } = deps;
  const app = createHttpServer({ config: deps.config, logger: deps.logger, readiness: deps.readiness });

  app.post<{ Body: StartSessionInput }>('/sessions', { schema: startSchema }, async (req, reply) => {
    const faulty = await flags.isEnabled(FLAGS.SIMULATE_CHARGER_HARDWARE_FAULT);
    const { session, created } = await repo.createSession(
      req.body,
      faulty ? 'FAILED' : 'ACTIVE',
      faulty ? HARDWARE_FAULT : undefined,
    );

    // Idempotencia: un reintento recibe el MISMO resultado que la primera vez.
    if (session.status === 'FAILED') {
      req.log2.warn('charger reported hardware fault', {
        event: 'charger_fault',
        saga_id: session.sagaId,
        station_id: session.stationId,
        connector_id: session.connectorId,
        fault_code: session.faultCode,
        replayed: !created,
      });
      throw new DomainError(HARDWARE_FAULT, `El cargador ${session.stationId}/${session.connectorId} reporto un error fisico`, 422, {
        sagaId: session.sagaId,
      });
    }

    req.log2.info(created ? 'charging session activated' : 'charging session replayed', {
      event: created ? 'charging_started' : 'charging_replayed',
      saga_id: session.sagaId,
      station_id: session.stationId,
      connector_id: session.connectorId,
      power_kw: session.powerKw,
    });
    return reply.status(created ? 201 : 200).send(session);
  });

  app.get<{ Querystring: { status?: SessionStatus } }>('/sessions', async (req) => repo.listSessions(req.query.status));

  app.get<{ Params: { sagaId: string } }>('/sessions/:sagaId', async (req) => {
    const session = await repo.getSession(req.params.sagaId);
    if (!session) throw new DomainError('SESSION_NOT_FOUND', `Sesion ${req.params.sagaId} no existe`, 404);
    return session;
  });

  app.get<{ Params: { stationId: string }; Querystring: { limit?: string } }>('/telemetry/:stationId', async (req) =>
    repo.listTelemetry(req.params.stationId, Math.min(Number(req.query.limit ?? 20), 200)),
  );

  return app;
}
