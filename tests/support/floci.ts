/**
 * Utilidades para pruebas de integracion y E2E contra Floci (DynamoDB real
 * emulado, NO AWS). Cada corrida crea tablas efimeras con el MISMO esquema que
 * Terraform (pk/sk + gsi1 + TTL) y un prefijo unico, asi las pruebas nunca
 * tocan los datos de los ambientes dev/test/prod.
 */
import { randomBytes } from 'node:crypto';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
  type CreateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { createDocumentClient, FLAGS, type BaseConfig } from '@aegisvolt/common';

process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_REGION ??= 'us-east-1';
export const FLOCI_ENDPOINT = process.env.AWS_ENDPOINT_URL || 'http://localhost:4566';

export interface TestTables {
  reservations: string;
  billing: string;
  dispatch: string;
  saga: string;
  flags: string;
}

export function testConfig(service: string, port = 0): BaseConfig {
  return {
    service,
    environment: 'dev',
    track: 'stable',
    version: 'test',
    port,
    project: 'aegisvolt',
    awsRegion: 'us-east-1',
    awsEndpoint: FLOCI_ENDPOINT,
    cloudWatchLogs: false,
  };
}

export const ddbDoc = () => createDocumentClient({ awsRegion: 'us-east-1', awsEndpoint: FLOCI_ENDPOINT });
const ddbRaw = () => new DynamoDBClient({ region: 'us-east-1', endpoint: FLOCI_ENDPOINT });

function pkSkTable(name: string, withGsi: boolean): CreateTableCommandInput {
  return {
    TableName: name,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
      ...(withGsi
        ? [
            { AttributeName: 'gsi1pk', AttributeType: 'S' as const },
            { AttributeName: 'gsi1sk', AttributeType: 'S' as const },
          ]
        : []),
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: withGsi
      ? [
          {
            IndexName: 'gsi1',
            KeySchema: [
              { AttributeName: 'gsi1pk', KeyType: 'HASH' },
              { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ]
      : undefined,
  };
}

export async function createTestTables(label: string): Promise<TestTables> {
  const prefix = `aegisvolt-it-${label}-${randomBytes(3).toString('hex')}`;
  const tables: TestTables = {
    reservations: `${prefix}-reservations`,
    billing: `${prefix}-billing`,
    dispatch: `${prefix}-dispatch`,
    saga: `${prefix}-saga`,
    flags: `${prefix}-feature-flags`,
  };
  const client = ddbRaw();
  const defs: CreateTableCommandInput[] = [
    pkSkTable(tables.reservations, true),
    pkSkTable(tables.billing, false),
    pkSkTable(tables.dispatch, false),
    pkSkTable(tables.saga, true),
    {
      TableName: tables.flags,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'flag', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'flag', KeyType: 'HASH' }],
    },
  ];
  await Promise.all(defs.map((d) => client.send(new CreateTableCommand(d))));
  await Promise.all(defs.map((d) => waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: d.TableName })));
  await seedFlags(tables.flags, {});
  return tables;
}

export async function seedFlags(table: string, values: Partial<Record<keyof typeof FLAGS, boolean>>): Promise<void> {
  const doc = ddbDoc();
  for (const name of Object.values(FLAGS)) {
    await doc.send(
      new PutCommand({
        TableName: table,
        Item: { flag: name, enabled: values[name] ?? false, description: `test ${name}`, environment: 'dev', updatedBy: 'test' },
      }),
    );
  }
}

export async function dropTestTables(tables: TestTables | undefined): Promise<void> {
  if (!tables) return;
  const client = ddbRaw();
  await Promise.allSettled(Object.values(tables).map((t) => client.send(new DeleteTableCommand({ TableName: t }))));
}
