/**
 * Levanta los 4 servicios en local contra las tablas REALES de un ambiente en
 * Floci (aegisvolt-*-<env>), para desarrollar el frontend o hacer demos sin
 * Kubernetes.
 *
 *   npm run dev:stack            # ambiente dev, gateway en http://localhost:8080/graphql
 *   AEGIS_ENV=test npm run dev:stack
 */
import { startProcessStack } from './processes.js';

const environment = (process.env.AEGIS_ENV ?? 'dev') as 'dev' | 'test' | 'prod';
const stack = await startProcessStack({
  environment,
  ports: { gateway: 8080, station: 8081, billing: 8082, dispatch: 8083 },
  extraEnv: { FLAG_ADMIN_ENABLED: environment === 'prod' ? 'false' : 'true', LOG_STDOUT: 'true' },
});

process.stdout.write(`AegisVolt (${environment}) listo: ${stack.gatewayUrl}/graphql\n`);
const shutdown = async () => {
  await stack.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
