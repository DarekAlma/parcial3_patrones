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
import { buildGatewayApp } from './app.js';
import { createBackends } from './clients.js';
import { SagaEngine } from './saga/engine.js';
import { DynamoSagaStore } from './saga/store.js';

const config = loadBaseConfig('graphql-gateway', 8080);
const logger = createLogger(config);
const ddb = createDocumentClient(config);
const sagaTable = tableName(config, 'saga');
const sagas = new DynamoSagaStore(ddb, sagaTable);

const app = buildGatewayApp({
  config,
  logger,
  sagas,
  flags: new FeatureFlagClient(ddb, tableName(config, 'feature-flags'), Number(env('FLAGS_CACHE_MS', '3000'))),
  backends: createBackends({
    station: env('STATION_SERVICE_URL', 'http://localhost:8081'),
    billing: env('BILLING_SERVICE_URL', 'http://localhost:8082'),
    dispatch: env('DISPATCH_SERVICE_URL', 'http://localhost:8083'),
  }),
  engine: new SagaEngine(sagas, logger, {
    compensationAttempts: Number(env('SAGA_COMPENSATION_ATTEMPTS', '4')),
    retriableAttempts: Number(env('SAGA_RETRIABLE_ATTEMPTS', '4')),
    backoffMs: Number(env('SAGA_BACKOFF_MS', '200')),
  }),
  // dev/test: true (demo de flags desde la UI). prod: false (ConfigMap).
  flagAdminEnabled: env('FLAG_ADMIN_ENABLED', 'false') === 'true',
  readiness: async () => {
    await ddb.send(new DescribeTableCommand({ TableName: sagaTable }));
  },
});

await start(app, config, logger);
