import { readFileSync } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createSchema, createYoga } from 'graphql-yoga';
import { createHttpServer } from '@aegisvolt/common';
import { createResolvers, type GatewayContext, type ResolverDeps } from './resolvers.js';

export const typeDefs = readFileSync(new URL('./schema.graphql', import.meta.url), 'utf8');

export interface GatewayAppDeps extends ResolverDeps {
  readiness?: () => Promise<void>;
}

/**
 * Capa de agregacion GraphQL: unico punto de entrada desde API Gateway.
 *   POST /graphql   esquema unificado (Queries + Mutations)
 *   GET  /flags     flags del ambiente (atajo REST para verificaciones)
 *   GET  /health    liveness (lo usa el health check del NLB)
 */
export function buildGatewayApp(deps: GatewayAppDeps) {
  const app = createHttpServer({ config: deps.config, logger: deps.logger, readiness: deps.readiness });

  type ServerContext = { req: FastifyRequest; reply: FastifyReply };
  const yoga = createYoga<ServerContext, GatewayContext>({
    schema: createSchema<ServerContext & GatewayContext>({ typeDefs, resolvers: createResolvers(deps) }),
    graphqlEndpoint: '/graphql',
    graphiql: deps.config.environment !== 'prod',
    landingPage: false,
    logging: false,
    context: ({ req }) => ({ correlationId: req.correlationId }),
  });

  app.route({
    url: '/graphql',
    method: ['GET', 'POST', 'OPTIONS'],
    handler: async (req, reply) => {
      const response = await yoga.handleNodeRequestAndResponse(req, reply, { req, reply });
      response.headers.forEach((value, key) => {
        void reply.header(key, value);
      });
      void reply.status(response.status);
      void reply.send(response.body);
      return reply;
    },
  });

  app.get('/flags', async () => ({
    environment: deps.config.environment,
    flags: (await deps.flags.list()).map((f) => ({ name: f.flag, enabled: f.enabled, updatedAt: f.updatedAt })),
  }));

  return app;
}
