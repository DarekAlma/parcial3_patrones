import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { BaseConfig } from './config.js';
import { DomainError } from './errors.js';
import type { Logger } from './logger.js';

export const CORRELATION_HEADER = 'x-correlation-id';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    log2: Logger;
  }
}

export interface ServerOptions {
  config: BaseConfig;
  logger: Logger;
  /** Verificacion de readiness (p. ej. que DynamoDB responda). */
  readiness?: () => Promise<void>;
}

/**
 * Servidor HTTP comun a todos los microservicios.
 *
 * - Propaga el correlation_id (header x-correlation-id) a request.correlationId
 *   y a un logger hijo (request.log2) => todos los logs de una SAGA comparten id.
 * - Registra cada request como event=http_request (base de RequestCount) y las
 *   respuestas 5xx con level=ERROR (base de ErrorCount) => tasa de error del canary.
 * - /health (liveness) y /ready (readiness) para Kubernetes y el NLB.
 * - INJECT_ERROR_RATE (0..1): perilla de demo para provocar errores 5xx en una
 *   version canary y demostrar el rollback automatico.
 */
export function createHttpServer({ config, logger, readiness }: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, genReqId: () => randomUUID(), bodyLimit: 256 * 1024 });
  const injectErrorRate = Number(process.env.INJECT_ERROR_RATE ?? '0');

  app.decorateRequest('correlationId', '');
  app.decorateRequest('log2', null as unknown as Logger);

  app.addHook('onRequest', async (request, reply) => {
    const incoming = request.headers[CORRELATION_HEADER];
    request.correlationId = (Array.isArray(incoming) ? incoming[0] : incoming) || request.id;
    request.log2 = logger.child({ correlation_id: request.correlationId });
    reply.header(CORRELATION_HEADER, request.correlationId);
    reply.header('x-aegis-track', config.track);

    const isProbe = request.url.startsWith('/health') || request.url.startsWith('/ready');
    if (injectErrorRate > 0 && !isProbe && Math.random() < injectErrorRate) {
      throw new DomainError('INJECTED_FAULT', 'Error inyectado (INJECT_ERROR_RATE)', 503);
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    if (request.url.startsWith('/health') || request.url.startsWith('/ready')) return;
    const fields = {
      event: 'http_request',
      method: request.method,
      route: request.routeOptions.url ?? request.url,
      status: reply.statusCode,
      latency_ms: Math.round(reply.elapsedTime),
    };
    if (reply.statusCode >= 500) request.log2.error('request failed', fields);
    else request.log2.info('request', fields);
  });

  app.setErrorHandler((rawError, request, reply) => {
    const error = rawError as Error & { validation?: unknown };
    if (error instanceof DomainError) {
      void reply.status(error.status).send({ code: error.code, message: error.message, details: error.details });
      return;
    }
    const validation = error.validation;
    if (validation) {
      void reply.status(400).send({ code: 'VALIDATION_ERROR', message: error.message });
      return;
    }
    request.log2?.error('unhandled error', { event: 'unhandled_error', error });
    void reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'Error interno' });
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: config.service,
    environment: config.environment,
    track: config.track,
    version: config.version,
  }));

  app.get('/ready', async (_request, reply) => {
    try {
      await readiness?.();
      return { status: 'ready' };
    } catch (err) {
      return reply.status(503).send({ status: 'not-ready', reason: (err as Error).message });
    }
  });

  return app;
}

/** Arranca el servidor y registra apagado ordenado (SIGTERM de Kubernetes). */
export async function start(app: FastifyInstance, config: BaseConfig, logger: Logger, onShutdown?: () => Promise<void>) {
  await app.listen({ host: '0.0.0.0', port: config.port });
  logger.info('service started', { event: 'service_started', port: config.port });

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { event: 'service_stopping', signal });
    await app.close();
    await onShutdown?.();
    await logger.flush();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}
