import { GetCommand, PutCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Feature flags por ambiente, almacenadas en DynamoDB (aegisvolt-feature-flags-<env>).
 *
 * - Cada ambiente lee SU tabla: cambiar una flag en dev no afecta test ni prod.
 * - Cache en memoria de pocos segundos: un cambio se refleja en todos los pods
 *   en <= cacheTtlMs SIN redesplegar ni reiniciar nada.
 * - Si DynamoDB no responde se usa el ultimo valor conocido (o el default),
 *   nunca se tumba la peticion por una flag.
 */
export const FLAGS = {
  ENABLE_DYNAMIC_SURGE_PRICING: 'ENABLE_DYNAMIC_SURGE_PRICING',
  ENABLE_FAST_CHARGE_BOOST: 'ENABLE_FAST_CHARGE_BOOST',
  SIMULATE_CHARGER_HARDWARE_FAULT: 'SIMULATE_CHARGER_HARDWARE_FAULT',
} as const;
export type FlagName = (typeof FLAGS)[keyof typeof FLAGS];

export interface FeatureFlag {
  flag: string;
  enabled: boolean;
  description?: string;
  environment?: string;
  updatedBy?: string;
  updatedAt?: string;
}

export interface FlagReader {
  isEnabled(name: FlagName): Promise<boolean>;
}

export class FeatureFlagClient implements FlagReader {
  private cache = new Map<string, { value: boolean; expires: number }>();

  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly cacheTtlMs = 3000,
    private readonly defaults: Partial<Record<FlagName, boolean>> = {},
  ) {}

  async isEnabled(name: FlagName): Promise<boolean> {
    const cached = this.cache.get(name);
    if (cached && cached.expires > Date.now()) return cached.value;
    try {
      const res = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { flag: name } }));
      const value = Boolean(res.Item?.enabled ?? this.defaults[name] ?? false);
      this.cache.set(name, { value, expires: Date.now() + this.cacheTtlMs });
      return value;
    } catch {
      return cached?.value ?? this.defaults[name] ?? false;
    }
  }

  async list(): Promise<FeatureFlag[]> {
    const res = await this.ddb.send(new ScanCommand({ TableName: this.table }));
    return ((res.Items ?? []) as FeatureFlag[]).sort((a, b) => a.flag.localeCompare(b.flag));
  }

  async set(name: string, enabled: boolean, updatedBy: string, environment: string): Promise<FeatureFlag> {
    const existing = await this.ddb.send(new GetCommand({ TableName: this.table, Key: { flag: name } }));
    if (!existing.Item) throw new Error(`Flag desconocida: ${name}`);
    const item: FeatureFlag = {
      ...(existing.Item as FeatureFlag),
      enabled,
      environment,
      updatedBy,
      updatedAt: new Date().toISOString(),
    };
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: item }));
    this.cache.delete(name);
    return item;
  }
}

/** Implementacion en memoria para pruebas unitarias. */
export class StaticFlags implements FlagReader {
  constructor(private readonly values: Partial<Record<FlagName, boolean>> = {}) {}
  set(name: FlagName, value: boolean): void {
    this.values[name] = value;
  }
  async isEnabled(name: FlagName): Promise<boolean> {
    return this.values[name] ?? false;
  }
}
