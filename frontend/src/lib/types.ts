export type EnvName = 'dev' | 'test' | 'prod';
export type ConnectorStatus = 'AVAILABLE' | 'RESERVED' | 'CHARGING' | 'OUT_OF_SERVICE';
export type SagaStatus = 'STARTED' | 'RESERVED' | 'CHARGED' | 'COMPLETED' | 'COMPENSATING' | 'COMPENSATED' | 'FAILED';
export type StepStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'COMPENSATING' | 'COMPENSATED' | 'COMPENSATION_FAILED';

export interface EnvironmentInfo {
  environment: EnvName;
  service: string;
  version: string;
  track: string;
  flagAdminEnabled: boolean;
}

export interface Connector {
  id: string;
  stationId: string;
  type: string;
  powerKw: number;
  tier: 'STANDARD' | 'ULTRA';
  status: ConnectorStatus;
  reservedBy: string | null;
  lockExpiresAt: number | null;
}

export interface Station {
  id: string;
  name: string;
  city: string;
  country: string;
  availableConnectors: number;
  totalConnectors: number;
  connectors: Connector[];
}

export interface TelemetryPoint {
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

export interface Wallet {
  fleetId: string;
  fleetName: string;
  balanceCents: number;
  currency: string;
}

export interface Quote {
  kwh: number;
  tier: 'STANDARD' | 'ULTRA';
  basePriceCentsPerKwh: number;
  priceCentsPerKwh: number;
  surgeEnabled: boolean;
  isPeakHour: boolean;
  surgeApplied: boolean;
  surgeMultiplier: number;
  amountCents: number;
  localHour: number;
}

export interface FeatureFlag {
  name: string;
  enabled: boolean;
  description: string | null;
  environment: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface SagaStep {
  name: string;
  kind: 'compensable' | 'pivot' | 'retriable';
  status: StepStatus;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  detail: string | null;
  error: string | null;
}

export interface Compensation {
  step: string;
  status: string;
  attempts: number;
  outcome: string | null;
  at: string;
  error: string | null;
}

export interface ChargeTransaction {
  sagaId: string;
  correlationId: string;
  status: SagaStatus;
  environment: string;
  fleetId: string;
  stationId: string;
  connectorId: string | null;
  priority: boolean;
  kwh: number;
  amountCents: number | null;
  quote: { priceCentsPerKwh: number; surgeApplied: boolean; tier: string } | null;
  steps: SagaStep[];
  compensations: Compensation[];
  error: { step: string; code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}
