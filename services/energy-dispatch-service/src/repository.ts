import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { isConditionalCheckFailed } from '@aegisvolt/common';

/**
 * Tabla aegisvolt-dispatch-<env>:
 *   SESSION#<sagaId>       | META            sesion de transferencia de energia
 *   TELEMETRY#<stationId>  | <isoTs>#<cid>   punto de telemetria (TTL expiresAt = 24 h)
 */
export type SessionStatus = 'ACTIVE' | 'COMPLETED' | 'FAILED';

export interface ChargingSession {
  sagaId: string;
  fleetId: string;
  stationId: string;
  connectorId: string;
  powerKw: number;
  kwhTarget: number;
  kwhDelivered: number;
  status: SessionStatus;
  faultCode?: string;
  startedAt: string;
  updatedAt: string;
  lastTickAt: number;
}

export interface TelemetryPoint {
  stationId: string;
  connectorId: string;
  sagaId: string;
  timestamp: string;
  powerKw: number;
  kwhDelivered: number;
  voltageV: number;
  currentA: number;
  temperatureC: number;
  socPercent: number;
}

export type StartSessionInput = Pick<ChargingSession, 'sagaId' | 'fleetId' | 'stationId' | 'connectorId' | 'powerKw' | 'kwhTarget'>;

const sessionPk = (sagaId: string) => `SESSION#${sagaId}`;
const telemetryPk = (stationId: string) => `TELEMETRY#${stationId}`;

export class DispatchRepository {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async getSession(sagaId: string): Promise<ChargingSession | null> {
    const res = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { pk: sessionPk(sagaId), sk: 'META' } }));
    return (res.Item as ChargingSession | undefined) ?? null;
  }

  /**
   * Crea la sesion una sola vez por sagaId (idempotente). Devuelve
   * { session, created }: si ya existia se devuelve la original sin cambios,
   * de modo que un reintento obtiene exactamente el mismo resultado.
   */
  async createSession(input: StartSessionInput, status: SessionStatus, faultCode?: string) {
    const iso = new Date().toISOString();
    const session: ChargingSession = {
      ...input,
      kwhDelivered: 0,
      status,
      faultCode,
      startedAt: iso,
      updatedAt: iso,
      lastTickAt: Date.now(),
    };
    try {
      await this.ddb.send(
        new PutCommand({
          TableName: this.table,
          Item: { pk: sessionPk(input.sagaId), sk: 'META', ...session },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return { session, created: true };
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      return { session: (await this.getSession(input.sagaId))!, created: false };
    }
  }

  async listSessions(status?: SessionStatus): Promise<ChargingSession[]> {
    const res = await this.ddb.send(
      new ScanCommand({
        TableName: this.table,
        FilterExpression: status ? 'begins_with(pk, :p) AND #s = :s' : 'begins_with(pk, :p)',
        ExpressionAttributeNames: status ? { '#s': 'status' } : undefined,
        ExpressionAttributeValues: status ? { ':p': 'SESSION#', ':s': status } : { ':p': 'SESSION#' },
      }),
    );
    return ((res.Items ?? []) as ChargingSession[]).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /**
   * Avanza la sesion. La condicion sobre lastTickAt garantiza que, con varias
   * replicas (stable + canary), solo UNA procese cada tick.
   */
  async advance(session: ChargingSession, kwhDelivered: number, minIntervalMs: number): Promise<boolean> {
    const now = Date.now();
    const done = kwhDelivered >= session.kwhTarget;
    try {
      await this.ddb.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: sessionPk(session.sagaId), sk: 'META' },
          UpdateExpression: 'SET kwhDelivered = :k, lastTickAt = :now, updatedAt = :iso, #s = :status',
          ConditionExpression: '#s = :active AND lastTickAt <= :threshold',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':k': Math.min(kwhDelivered, session.kwhTarget),
            ':now': now,
            ':iso': new Date(now).toISOString(),
            ':status': done ? 'COMPLETED' : 'ACTIVE',
            ':active': 'ACTIVE',
            ':threshold': now - minIntervalMs,
          },
        }),
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return false;
      throw err;
    }
  }

  async putTelemetry(point: TelemetryPoint): Promise<void> {
    await this.ddb.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          pk: telemetryPk(point.stationId),
          sk: `${point.timestamp}#${point.connectorId}`,
          ...point,
          expiresAt: Math.floor(Date.now() / 1000) + 24 * 3600,
        },
      }),
    );
  }

  async listTelemetry(stationId: string, limit: number): Promise<TelemetryPoint[]> {
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': telemetryPk(stationId) },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (res.Items ?? []).map((i) => {
      const { pk: _pk, sk: _sk, expiresAt: _e, ...point } = i;
      return point as TelemetryPoint;
    });
  }
}
