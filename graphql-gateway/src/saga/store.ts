import { GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { isConditionalCheckFailed } from '@aegisvolt/common';
import type { SagaRecord, SagaStatus, SagaStore } from './types.js';

/**
 * Log de SAGAs en aegisvolt-saga-<env>:
 *   SAGA#<sagaId> | META    registro completo (pasos, compensaciones, error)
 *   gsi1: gsi1pk = "SAGA", gsi1sk = <createdAt>#<sagaId>   => historial ordenado
 *
 * create(): attribute_not_exists => un sagaId (idempotencyKey) se ejecuta una sola vez.
 * save():   concurrencia optimista por "version" => dos procesos no pisan el log.
 */
export class DynamoSagaStore implements SagaStore {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  private item(record: SagaRecord) {
    return {
      pk: `SAGA#${record.sagaId}`,
      sk: 'META',
      gsi1pk: 'SAGA',
      gsi1sk: `${record.createdAt}#${record.sagaId}`,
      ...record,
    };
  }

  async create(record: SagaRecord): Promise<boolean> {
    try {
      record.version = 1;
      await this.ddb.send(
        new PutCommand({ TableName: this.table, Item: this.item(record), ConditionExpression: 'attribute_not_exists(pk)' }),
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return false;
      throw err;
    }
  }

  async save(record: SagaRecord): Promise<void> {
    const expected = record.version;
    record.version = expected + 1;
    try {
      await this.ddb.send(
        new PutCommand({
          TableName: this.table,
          Item: this.item(record),
          ConditionExpression: '#v = :expected',
          ExpressionAttributeNames: { '#v': 'version' },
          ExpressionAttributeValues: { ':expected': expected },
        }),
      );
    } catch (err) {
      record.version = expected;
      if (isConditionalCheckFailed(err)) {
        throw new Error(`Conflicto de concurrencia en la SAGA ${record.sagaId} (version ${expected})`);
      }
      throw err;
    }
  }

  async get(sagaId: string): Promise<SagaRecord | null> {
    const res = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { pk: `SAGA#${sagaId}`, sk: 'META' } }));
    return res.Item ? strip(res.Item) : null;
  }

  async list(limit: number, status?: SagaStatus): Promise<SagaRecord[]> {
    const out: SagaRecord[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.ddb.send(
        new QueryCommand({
          TableName: this.table,
          IndexName: 'gsi1',
          KeyConditionExpression: 'gsi1pk = :p',
          FilterExpression: status ? '#s = :s' : undefined,
          ExpressionAttributeNames: status ? { '#s': 'status' } : undefined,
          ExpressionAttributeValues: status ? { ':p': 'SAGA', ':s': status } : { ':p': 'SAGA' },
          ScanIndexForward: false,
          Limit: Math.max(limit, 25),
          ExclusiveStartKey,
        }),
      );
      out.push(...(res.Items ?? []).map(strip));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey && out.length < limit);
    return out.slice(0, limit);
  }
}

function strip(item: Record<string, unknown>): SagaRecord {
  const { pk: _pk, sk: _sk, gsi1pk: _g1, gsi1sk: _g2, ...record } = item;
  return record as unknown as SagaRecord;
}

/** Store en memoria para pruebas unitarias del motor. */
export class InMemorySagaStore implements SagaStore {
  readonly records = new Map<string, SagaRecord>();
  readonly history: SagaStatus[] = [];

  async create(record: SagaRecord): Promise<boolean> {
    if (this.records.has(record.sagaId)) return false;
    record.version = 1;
    this.records.set(record.sagaId, structuredClone(record));
    this.history.push(record.status);
    return true;
  }

  async save(record: SagaRecord): Promise<void> {
    record.version += 1;
    this.records.set(record.sagaId, structuredClone(record));
    if (this.history.at(-1) !== record.status) this.history.push(record.status);
  }

  async get(sagaId: string): Promise<SagaRecord | null> {
    const r = this.records.get(sagaId);
    return r ? structuredClone(r) : null;
  }
}
