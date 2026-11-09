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
import { parsePeakHours } from './pricing.js';
import { SEED_WALLETS, WalletRepository } from './repository.js';

const config = loadBaseConfig('billing-wallet-service', 8082);
const logger = createLogger(config);
const ddb = createDocumentClient(config);
const table = tableName(config, 'billing');
const repo = new WalletRepository(ddb, table);
const flags = new FeatureFlagClient(ddb, tableName(config, 'feature-flags'), Number(env('FLAGS_CACHE_MS', '3000')));

if (env('SEED_DATA', 'true') === 'true') {
  const created = await repo.seed(SEED_WALLETS);
  logger.info('seed completed', { event: 'seed_completed', created, table });
}

const app = buildApp({
  config,
  logger,
  repo,
  flags,
  peakHours: parsePeakHours(env('PEAK_HOURS', '7-10,17-21')),
  timeZone: env('PRICING_TIMEZONE', 'America/Bogota'),
  readiness: async () => {
    await ddb.send(new DescribeTableCommand({ TableName: table }));
  },
});

await start(app, config, logger);
