import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import {
  FeatureFlagClient,
  createDocumentClient,
  createLogger,
  env,
  loadBaseConfig,
  start,
  tableName,
} from '@aegisvolt/common';
import { buildApp } from './app.js';
import { SEED_STATIONS } from './domain.js';
import { ReservationRepository } from './repository.js';

const config = loadBaseConfig('station-reservation-service', 8081);
const logger = createLogger(config);
const ddb = createDocumentClient(config);
const table = tableName(config, 'reservations');
const repo = new ReservationRepository(ddb, table);
const flags = new FeatureFlagClient(ddb, tableName(config, 'feature-flags'), Number(env('FLAGS_CACHE_MS', '3000')));

if (env('SEED_DATA', 'true') === 'true') {
  const created = await repo.seed(SEED_STATIONS);
  logger.info('seed completed', { event: 'seed_completed', created, table });
}

const app = buildApp({
  config,
  logger,
  repo,
  flags,
  lockSeconds: Number(env('RESERVATION_LOCK_SECONDS', '300')),
  priorityLockSeconds: Number(env('PRIORITY_LOCK_SECONDS', '600')),
  readiness: async () => {
    await ddb.send(new DescribeTableCommand({ TableName: table }));
  },
});

await start(app, config, logger);
