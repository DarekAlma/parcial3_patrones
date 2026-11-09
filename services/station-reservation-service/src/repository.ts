import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { DomainError, isConditionalCheckFailed, transactionCancellationReasons } from '@aegisvolt/common';
import {
  effectiveStatus,
  pickCandidates,
  type Connector,
  type Reservation,
  type ReserveInput,
  type Station,
  type StationView,
} from './domain.js';

const stationPk = (id: string) => `STATION#${id}`;
const connectorSk = (id: string) => `CONNECTOR#${id}`;
const reservationPk = (sagaId: string) => `RESERVATION#${sagaId}`;
const META = 'META';

export interface ReleaseResult {
  sagaId: string;
  released: boolean;
  /** true si ya estaba liberada: la compensacion se proceso antes (idempotencia). */
  alreadyReleased: boolean;
  outcome: 'RELEASED' | 'ALREADY_RELEASED' | 'NOTHING_TO_RELEASE';
}

/**
 * Acceso a DynamoDB del servicio de reservas. Todas las operaciones de la SAGA
 * son IDEMPOTENTES por sagaId: repetir reserve/release/confirm con el mismo
 * sagaId no duplica efectos (escrituras condicionales + transacciones).
 */
export class ReservationRepository {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  // ---------------------------------------------------------------- lecturas
  async listStations(): Promise<StationView[]> {
    const [stations, connectors] = await Promise.all([this.queryGsi('STATION'), this.queryGsi('CONNECTOR')]);
    const now = this.now();
    return (stations as unknown as Station[])
      .map((s) => ({
        ...pick(s),
        connectors: (connectors as unknown as Connector[])
          .filter((c) => c.stationId === s.stationId)
          .map((c) => toConnectorView(c, now))
          .sort((a, b) => a.connectorId.localeCompare(b.connectorId)),
      }))
      .sort((a, b) => a.stationId.localeCompare(b.stationId));
  }

  async getStation(stationId: string): Promise<StationView | null> {
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': stationPk(stationId) },
      }),
    );
    const items = res.Items ?? [];
    const meta = items.find((i) => i.sk === META);
    if (!meta) return null;
    const now = this.now();
    return {
      ...pick(meta as Station),
      connectors: items
        .filter((i) => String(i.sk).startsWith('CONNECTOR#'))
        .map((c) => toConnectorView(c as Connector, now))
        .sort((a, b) => a.connectorId.localeCompare(b.connectorId)),
    };
  }

  async getReservation(sagaId: string): Promise<Reservation | null> {
    const res = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { pk: reservationPk(sagaId), sk: META } }));
    return (res.Item as Reservation | undefined) ?? null;
  }

  // ------------------------------------------------------- paso 1 de la SAGA
  async reserve(input: ReserveInput, lockSeconds: number): Promise<Reservation> {
    const existing = await this.getReservation(input.sagaId);
    if (existing) return assertReplayable(existing);

    const station = await this.getStation(input.stationId);
    if (!station) throw new DomainError('STATION_NOT_FOUND', `Estacion ${input.stationId} no existe`, 404);

    const now = this.now();
    const priority = Boolean(input.priority);
    let candidates: Connector[];
    if (input.connectorId) {
      const c = station.connectors.find((x) => x.connectorId === input.connectorId);
      if (!c) throw new DomainError('CONNECTOR_NOT_FOUND', `Conector ${input.connectorId} no existe`, 404);
      if (effectiveStatus(c, now) !== 'AVAILABLE') {
        throw new DomainError('CONNECTOR_UNAVAILABLE', `Conector ${input.connectorId} no disponible (${c.status})`, 409);
      }
      candidates = [c];
    } else {
      candidates = pickCandidates(station.connectors, priority, now);
    }
    if (candidates.length === 0) {
      throw new DomainError(
        'NO_CONNECTOR_AVAILABLE',
        `No hay conectores ${priority ? 'ULTRA' : 'STANDARD'} disponibles en ${input.stationId}`,
        409,
      );
    }

    for (const connector of candidates) {
      const isoNow = new Date().toISOString();
      const reservation: Reservation = {
        sagaId: input.sagaId,
        fleetId: input.fleetId,
        stationId: input.stationId,
        connectorId: connector.connectorId,
        priority,
        tier: connector.tier,
        powerKw: connector.powerKw,
        status: 'HELD',
        createdAt: isoNow,
        updatedAt: isoNow,
        expiresAt: now + lockSeconds + 3600, // TTL: limpieza de reservas HELD abandonadas
      };
      try {
        await this.ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                // Bloqueo temporal de la bahia: solo si esta libre o su lock vencio.
                Update: {
                  TableName: this.table,
                  Key: { pk: stationPk(input.stationId), sk: connectorSk(connector.connectorId) },
                  UpdateExpression: 'SET #s = :reserved, reservedBy = :saga, lockExpiresAt = :exp, updatedAt = :iso',
                  ConditionExpression: '#s = :available OR (#s = :reserved AND lockExpiresAt < :now)',
                  ExpressionAttributeNames: { '#s': 'status' },
                  ExpressionAttributeValues: {
                    ':reserved': 'RESERVED',
                    ':available': 'AVAILABLE',
                    ':saga': input.sagaId,
                    ':exp': now + lockSeconds,
                    ':now': now,
                    ':iso': isoNow,
                  },
                },
              },
              {
                // Clave de idempotencia: una sola reserva por sagaId.
                Put: {
                  TableName: this.table,
                  Item: { pk: reservationPk(input.sagaId), sk: META, ...reservation },
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
            ],
          }),
        );
        return reservation;
      } catch (err) {
        const reasons = transactionCancellationReasons(err);
        if (!reasons) throw err;
        if (reasons[1] === 'ConditionalCheckFailed') {
          // Otra peticion con el mismo sagaId gano la carrera: devolver la existente.
          const winner = await this.getReservation(input.sagaId);
          if (winner) return assertReplayable(winner);
        }
        // El conector fue tomado entre la lectura y la escritura: probar el siguiente.
      }
    }
    throw new DomainError('NO_CONNECTOR_AVAILABLE', 'Los conectores candidatos fueron tomados por otra reserva', 409);
  }

  // --------------------------------------------- compensacion del paso 1
  async release(sagaId: string, reason: string): Promise<ReleaseResult> {
    const reservation = await this.getReservation(sagaId);
    if (!reservation) return { sagaId, released: false, alreadyReleased: false, outcome: 'NOTHING_TO_RELEASE' };
    if (reservation.status === 'RELEASED') {
      return { sagaId, released: true, alreadyReleased: true, outcome: 'ALREADY_RELEASED' };
    }

    const isoNow = new Date().toISOString();
    const releaseReservation = {
      Update: {
        TableName: this.table,
        Key: { pk: reservationPk(sagaId), sk: META },
        UpdateExpression: 'SET #s = :released, releaseReason = :reason, updatedAt = :iso',
        ConditionExpression: '#s IN (:held, :confirmed)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':released': 'RELEASED',
          ':reason': reason,
          ':iso': isoNow,
          ':held': 'HELD',
          ':confirmed': 'CONFIRMED',
        },
      },
    };
    try {
      await this.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            releaseReservation,
            {
              // Solo libera el conector si sigue bloqueado por ESTA saga.
              Update: {
                TableName: this.table,
                Key: { pk: stationPk(reservation.stationId), sk: connectorSk(reservation.connectorId) },
                UpdateExpression: 'SET #s = :available, updatedAt = :iso REMOVE reservedBy, lockExpiresAt',
                ConditionExpression: 'reservedBy = :saga',
                ExpressionAttributeNames: { '#s': 'status' },
                ExpressionAttributeValues: { ':available': 'AVAILABLE', ':saga': sagaId, ':iso': isoNow },
              },
            },
          ],
        }),
      );
    } catch (err) {
      const reasons = transactionCancellationReasons(err);
      if (!reasons) throw err;
      if (reasons[0] === 'ConditionalCheckFailed') {
        // Liberada en paralelo por otra entrega del mismo mensaje.
        return { sagaId, released: true, alreadyReleased: true, outcome: 'ALREADY_RELEASED' };
      }
      // El lock vencio y otra saga tomo el conector: se libera solo la reserva.
      await this.ddb.send(new UpdateCommand(releaseReservation.Update));
    }
    return { sagaId, released: true, alreadyReleased: false, outcome: 'RELEASED' };
  }

  // ------------------------------------- confirmacion tras activar la carga
  async confirm(sagaId: string): Promise<Reservation> {
    return this.transition(sagaId, 'HELD', 'CONFIRMED', 'RESERVED', 'CHARGING');
  }

  /** Fin de la sesion de carga: la bahia vuelve a estar disponible. */
  async complete(sagaId: string): Promise<Reservation> {
    return this.transition(sagaId, 'CONFIRMED', 'COMPLETED', 'CHARGING', 'AVAILABLE');
  }

  private async transition(
    sagaId: string,
    from: Reservation['status'],
    to: Reservation['status'],
    connectorFrom: Connector['status'],
    connectorTo: Connector['status'],
  ): Promise<Reservation> {
    const reservation = await this.getReservation(sagaId);
    if (!reservation) throw new DomainError('RESERVATION_NOT_FOUND', `Reserva ${sagaId} no existe`, 404);
    if (reservation.status === to) return reservation; // idempotente
    if (reservation.status !== from) {
      throw new DomainError('INVALID_RESERVATION_STATE', `Reserva en ${reservation.status}, se esperaba ${from}`, 409);
    }
    const isoNow = new Date().toISOString();
    const releaseLock = connectorTo === 'AVAILABLE' ? ' REMOVE reservedBy, lockExpiresAt' : '';
    try {
      await this.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: { pk: reservationPk(sagaId), sk: META },
                UpdateExpression: 'SET #s = :to, updatedAt = :iso REMOVE expiresAt',
                ConditionExpression: '#s = :from',
                ExpressionAttributeNames: { '#s': 'status' },
                ExpressionAttributeValues: { ':to': to, ':from': from, ':iso': isoNow },
              },
            },
            {
              Update: {
                  TableName: this.table,
                  Key: { pk: stationPk(reservation.stationId), sk: connectorSk(reservation.connectorId) },
                  UpdateExpression: `SET #s = :to, updatedAt = :iso${releaseLock}`,
                  ConditionExpression: '#s = :from AND reservedBy = :saga',
                  ExpressionAttributeNames: { '#s': 'status' },
                  ExpressionAttributeValues: { ':to': connectorTo, ':from': connectorFrom, ':saga': sagaId, ':iso': isoNow },
                },
              },
            ],
          }),
      );
    } catch (err) {
      if (!transactionCancellationReasons(err)) throw err;
      const current = await this.getReservation(sagaId);
      if (current?.status === to) return current;
      throw new DomainError('INVALID_RESERVATION_STATE', `No se pudo pasar la reserva ${sagaId} a ${to}`, 409);
    }
    return { ...reservation, status: to, updatedAt: isoNow };
  }

  // ------------------------------------------------------------------ seed
  /** Carga las estaciones de ejemplo si no existen (idempotente, seguro con varias replicas). */
  async seed(stations: StationView[]): Promise<number> {
    let created = 0;
    for (const s of stations) {
      const { connectors, ...meta } = s;
      created += await this.putIfAbsent({ pk: stationPk(s.stationId), sk: META, gsi1pk: 'STATION', gsi1sk: s.stationId, ...meta });
      for (const c of connectors) {
        created += await this.putIfAbsent({
          pk: stationPk(c.stationId),
          sk: connectorSk(c.connectorId),
          gsi1pk: 'CONNECTOR',
          gsi1sk: `${c.stationId}#${c.connectorId}`,
          ...c,
        });
      }
    }
    return created;
  }

  private async putIfAbsent(item: Record<string, unknown>): Promise<number> {
    try {
      await this.ddb.send(new PutCommand({ TableName: this.table, Item: item, ConditionExpression: 'attribute_not_exists(pk)' }));
      return 1;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return 0;
      throw err;
    }
  }

  private async queryGsi(type: string): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.ddb.send(
        new QueryCommand({
          TableName: this.table,
          IndexName: 'gsi1',
          KeyConditionExpression: 'gsi1pk = :t',
          ExpressionAttributeValues: { ':t': type },
          ExclusiveStartKey,
        }),
      );
      items.push(...(res.Items ?? []));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }
}

function assertReplayable(existing: Reservation): Reservation {
  if (existing.status === 'RELEASED') {
    throw new DomainError('RESERVATION_RELEASED', `La reserva ${existing.sagaId} ya fue liberada`, 409);
  }
  return existing;
}

function pick(s: Station): Station {
  return { stationId: s.stationId, name: s.name, city: s.city, country: s.country, lat: s.lat, lng: s.lng };
}

function toConnectorView(c: Connector, now: number): Connector {
  const status = effectiveStatus(c, now);
  return {
    stationId: c.stationId,
    connectorId: c.connectorId,
    type: c.type,
    powerKw: c.powerKw,
    tier: c.tier,
    status,
    reservedBy: status === 'AVAILABLE' ? undefined : c.reservedBy,
    lockExpiresAt: status === 'RESERVED' ? c.lockExpiresAt : undefined,
    updatedAt: c.updatedAt,
  };
}
