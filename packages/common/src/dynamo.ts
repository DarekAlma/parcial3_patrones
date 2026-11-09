import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { BaseConfig } from './config.js';

/**
 * Cliente DynamoDB (DocumentClient). En Kubernetes el endpoint apunta a Floci;
 * en AWS real (AWS_ENDPOINT_URL vacio) el SDK resuelve dynamodb.<region>.amazonaws.com,
 * que dentro de la VPC viaja por el Gateway VPC Endpoint de DynamoDB.
 */
export function createDocumentClient(config: Pick<BaseConfig, 'awsRegion' | 'awsEndpoint'>): DynamoDBDocumentClient {
  const client = new DynamoDBClient({
    region: config.awsRegion,
    endpoint: config.awsEndpoint,
    maxAttempts: 3,
  });
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

export const nowEpochSeconds = (): number => Math.floor(Date.now() / 1000);
