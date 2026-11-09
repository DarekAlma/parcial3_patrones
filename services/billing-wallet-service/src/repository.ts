import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { DomainError, isConditionalCheckFailed, transactionCancellationReasons } from '@aegisvolt/common';

/**
 * Tabla aegisvolt-billing-<env>:
 *   WALLET#<fleetId> | META                     billetera (balanceCents)
 *   WALLET#<fleetId> | TXN#<sagaId>#CHARGE      cobro de la SAGA
 *   WALLET#<fleetId> | TXN#<sagaId>#REFUND      reembolso compensatorio (evento de reversion)
 *
 * La sk deterministica por sagaId es la CLAVE DE IDEMPOTENCIA: un segundo
 * cobro o reembolso con el mismo sagaId choca con attribute_not_exists y no
 * vuelve a mover saldo.
 */
export interface Wallet {
  fleetId: string;
  fleetName: string;
  balanceCents: number;
  currency: 'USD';
  updatedAt?: string;
}

export interface WalletTransaction {
  sagaId: string;
  fleetId: string;
  type: 'CHARGE' | 'REFUND';
  amountCents: number;
  description: string;
  createdAt: string;
}

export interface ChargeInput {
  sagaId: string;
  fleetId: string;
  amountCents: number;
  description?: string;
}

export interface ChargeResult {
  transaction: WalletTransaction;
  /** true si el cobro ya existia (reintento del mismo sagaId). */
  replayed: boolean;
}

export interface RefundResult {
  sagaId: string;
  refunded: boolean;
  alreadyRefunded: boolean;
  outcome: 'REFUNDED' | 'ALREADY_REFUNDED' | 'NOTHING_TO_REFUND';
  transaction?: WalletTransaction;
}

const walletPk = (fleetId: string) => `WALLET#${fleetId}`;
const txnSk = (sagaId: string, type: WalletTransaction['type']) => `TXN#${sagaId}#${type}`;

export class WalletRepository {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async getWallet(fleetId: string): Promise<Wallet | null> {
    const res = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { pk: walletPk(fleetId), sk: 'META' } }));
    return res.Item ? toWallet(res.Item) : null;
  }

  async listWallets(): Promise<Wallet[]> {
    // Pocas billeteras por ambiente: Scan acotado a los items META.
    const res = await this.ddb.send(
      new ScanCommand({ TableName: this.table, FilterExpression: 'sk = :meta', ExpressionAttributeValues: { ':meta': 'META' } }),
    );
    return (res.Items ?? []).map(toWallet).sort((a, b) => a.fleetId.localeCompare(b.fleetId));
  }

  async listTransactions(fleetId: string, limit = 50): Promise<WalletTransaction[]> {
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :txn)',
        ExpressionAttributeValues: { ':pk': walletPk(fleetId), ':txn': 'TXN#' },
      }),
    );
    return ((res.Items ?? []) as WalletTransaction[])
      .map(toTxn)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async getTransaction(fleetId: string, sagaId: string, type: WalletTransaction['type']): Promise<WalletTransaction | null> {
    const res = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { pk: walletPk(fleetId), sk: txnSk(sagaId, type) } }));
    return res.Item ? toTxn(res.Item as WalletTransaction) : null;
  }

  // ------------------------------------------------------- paso 2 de la SAGA
  async charge(input: ChargeInput): Promise<ChargeResult> {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new DomainError('INVALID_AMOUNT', 'amountCents debe ser un entero positivo', 400);
    }
    const existing = await this.getTransaction(input.fleetId, input.sagaId, 'CHARGE');
    if (existing) return { transaction: existing, replayed: true };

    const txn: WalletTransaction = {
      sagaId: input.sagaId,
      fleetId: input.fleetId,
      type: 'CHARGE',
      amountCents: input.amountCents,
      description: input.description ?? 'Retencion de saldo por sesion de carga',
      createdAt: new Date().toISOString(),
    };
    try {
      // Atomico: o se descuenta el saldo Y se registra el cobro, o no pasa nada.
      await this.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: { pk: walletPk(input.fleetId), sk: 'META' },
                UpdateExpression: 'SET balanceCents = balanceCents - :a, updatedAt = :iso',
                ConditionExpression: 'attribute_exists(pk) AND balanceCents >= :a',
                ExpressionAttributeValues: { ':a': input.amountCents, ':iso': txn.createdAt },
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { pk: walletPk(input.fleetId), sk: txnSk(input.sagaId, 'CHARGE'), ...txn },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      );
      return { transaction: txn, replayed: false };
    } catch (err) {
      const reasons = transactionCancellationReasons(err);
      if (!reasons) throw err;
      if (reasons[1] === 'ConditionalCheckFailed') {
        const winner = await this.getTransaction(input.fleetId, input.sagaId, 'CHARGE');
        if (winner) return { transaction: winner, replayed: true };
      }
      const wallet = await this.getWallet(input.fleetId);
      if (!wallet) throw new DomainError('WALLET_NOT_FOUND', `La flota ${input.fleetId} no tiene billetera`, 404);
      throw new DomainError('INSUFFICIENT_FUNDS', `Fondos insuficientes en ${input.fleetId}`, 402, {
        balanceCents: wallet.balanceCents,
        requiredCents: input.amountCents,
      });
    }
  }

  // --------------------------------------------- compensacion del paso 2
  async refund(fleetId: string, sagaId: string, reason: string): Promise<RefundResult> {
    const charge = await this.getTransaction(fleetId, sagaId, 'CHARGE');
    if (!charge) return { sagaId, refunded: false, alreadyRefunded: false, outcome: 'NOTHING_TO_REFUND' };

    const existingRefund = await this.getTransaction(fleetId, sagaId, 'REFUND');
    if (existingRefund) {
      return { sagaId, refunded: true, alreadyRefunded: true, outcome: 'ALREADY_REFUNDED', transaction: existingRefund };
    }

    const refund: WalletTransaction = {
      sagaId,
      fleetId,
      type: 'REFUND',
      amountCents: charge.amountCents,
      description: `Reembolso compensatorio: ${reason}`,
      createdAt: new Date().toISOString(),
    };
    try {
      await this.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              // Evento de reversion; attribute_not_exists impide reembolsar dos veces.
              Put: {
                TableName: this.table,
                Item: { pk: walletPk(fleetId), sk: txnSk(sagaId, 'REFUND'), ...refund },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: { pk: walletPk(fleetId), sk: 'META' },
                UpdateExpression: 'SET balanceCents = balanceCents + :a, updatedAt = :iso',
                ConditionExpression: 'attribute_exists(pk)',
                ExpressionAttributeValues: { ':a': charge.amountCents, ':iso': refund.createdAt },
              },
            },
          ],
        }),
      );
    } catch (err) {
      const reasons = transactionCancellationReasons(err);
      if (reasons?.[0] === 'ConditionalCheckFailed') {
        const winner = await this.getTransaction(fleetId, sagaId, 'REFUND');
        return { sagaId, refunded: true, alreadyRefunded: true, outcome: 'ALREADY_REFUNDED', transaction: winner ?? undefined };
      }
      throw err;
    }
    return { sagaId, refunded: true, alreadyRefunded: false, outcome: 'REFUNDED', transaction: refund };
  }

  async seed(wallets: Omit<Wallet, 'updatedAt'>[]): Promise<number> {
    let created = 0;
    for (const w of wallets) {
      try {
        await this.ddb.send(
          new PutCommand({
            TableName: this.table,
            Item: { pk: walletPk(w.fleetId), sk: 'META', ...w, updatedAt: new Date().toISOString() },
            ConditionExpression: 'attribute_not_exists(pk)',
          }),
        );
        created++;
      } catch (err) {
        if (!isConditionalCheckFailed(err)) throw err;
      }
    }
    return created;
  }

  /** Recarga de saldo (operacion administrativa para demos). */
  async topUp(fleetId: string, amountCents: number): Promise<Wallet> {
    try {
      const res = await this.ddb.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: walletPk(fleetId), sk: 'META' },
          UpdateExpression: 'SET balanceCents = balanceCents + :a, updatedAt = :iso',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: { ':a': amountCents, ':iso': new Date().toISOString() },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return toWallet(res.Attributes!);
    } catch (err) {
      if (isConditionalCheckFailed(err)) throw new DomainError('WALLET_NOT_FOUND', `La flota ${fleetId} no tiene billetera`, 404);
      throw err;
    }
  }
}

function toWallet(item: Record<string, unknown>): Wallet {
  return {
    fleetId: String(item.fleetId),
    fleetName: String(item.fleetName),
    balanceCents: Number(item.balanceCents),
    currency: 'USD',
    updatedAt: item.updatedAt as string | undefined,
  };
}

function toTxn(item: WalletTransaction): WalletTransaction {
  return {
    sagaId: item.sagaId,
    fleetId: item.fleetId,
    type: item.type,
    amountCents: Number(item.amountCents),
    description: item.description,
    createdAt: item.createdAt,
  };
}

export const SEED_WALLETS: Omit<Wallet, 'updatedAt'>[] = [
  { fleetId: 'fleet-andina', fleetName: 'Logistica Andina Express', balanceCents: 50_000, currency: 'USD' },
  { fleetId: 'fleet-pacifico', fleetName: 'Reparto Pacifico Ultima Milla', balanceCents: 20_000, currency: 'USD' },
  // Saldo bajo a proposito: demuestra la compensacion del Paso 2 (fondos insuficientes).
  { fleetId: 'fleet-caribe', fleetName: 'Caribe Delivery (saldo bajo)', balanceCents: 500, currency: 'USD' },
];
