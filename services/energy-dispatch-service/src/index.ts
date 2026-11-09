import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import {
  FeatureFlagClient,
  ServiceClient,
  createDocumentClient,
  createLogger,
  env,
  loadBaseConfig,
  start,
  tableName,
} from '@aegisvolt/common';
import { buildApp } from './app.js';
import { DispatchRepository } from './repository.js';
import { ChargingSimulator } from './simulator.js';

const config = loadBaseConfig('energy-dispatch-service', 8083);
const logger = createLogger(config);
const ddb = createDocumentClient(config);
const table = tableName(config, 'dispatch');
const repo = new DispatchRepository(ddb, table);
const flags = new FeatureFlagClient(ddb, tableName(config, 'feature-flags'), Number(env('FLAGS_CACHE_MS', '3000')));
const stations = new ServiceClient('station-reservation-service', env('STATION_SERVICE_URL', 'http://localhost:8081'));

const simulator = new ChargingSimulator(
  repo,
  stations,
  logger,
  Number(env('SIMULATOR_INTERVAL_MS', '2000')),
  Number(env('SIMULATOR_SPEED_FACTOR', '60')),
);

const app = buildApp({
  config,
  logger,
  repo,
  flags,
  readiness: async () => {
    await ddb.send(new DescribeTableCommand({ TableName: table }));
  },
});

if (env('SIMULATOR_ENABLED', 'true') === 'true') simulator.start();
await start(app, config, logger, async () => simulator.stop());
