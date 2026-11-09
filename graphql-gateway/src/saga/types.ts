/**
 * Tipos del log de la SAGA (tabla aegisvolt-saga-<env>).
 *
 * Clasificacion de pasos (Garcia-Molina & Salem, "Sagas", 1987; Richardson,
 * "Microservices Patterns"):
 *   compensable -> si un paso posterior falla, se deshace con su compensacion.
 *   pivot       -> punto de no retorno: si falla se compensa lo anterior; si
 *                  tiene exito la SAGA ya no se revierte.
 *   retriable   -> pasos posteriores al pivot: no se compensan, se reintentan
 *                  hasta completar (deben ser idempotentes).
 */
export type StepKind = 'compensable' | 'pivot' | 'retriable';

export type SagaStatus =
  | 'STARTED'
  | 'RESERVED'
  | 'CHARGED'
  | 'COMPLETED'
  | 'COMPENSATING'
  | 'COMPENSATED'
  | 'FAILED';

export const TERMINAL_STATUSES: SagaStatus[] = ['COMPLETED', 'COMPENSATED', 'FAILED'];

export type StepStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'COMPENSATING'
  | 'COMPENSATED'
  | 'COMPENSATION_FAILED';

export interface StepRecord {
  name: string;
  kind: StepKind;
  status: StepStatus;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  detail?: Record<string, unknown>;
  error?: string;
}

export interface CompensationRecord {
  step: string;
  status: 'SUCCEEDED' | 'FAILED';
  attempts: number;
  /** Resultado reportado por el servicio: RELEASED, ALREADY_RELEASED, REFUNDED, ALREADY_REFUNDED, NOTHING_TO_... */
  outcome?: string;
  at: string;
  error?: string;
}

export interface SagaError {
  step: string;
  code: string;
  message: string;
}

export interface SagaRecord<I = Record<string, unknown>> {
  sagaId: string;
  type: string;
  status: SagaStatus;
  environment: string;
  input: I;
  /** Datos producidos por los pasos (reserva, monto, sesion...). */
  data: Record<string, unknown>;
  steps: StepRecord[];
  compensations: CompensationRecord[];
  error?: SagaError;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** Concurrencia optimista: cada escritura incrementa version. */
  version: number;
}

export interface SagaStore {
  create(record: SagaRecord): Promise<boolean>;
  save(record: SagaRecord): Promise<void>;
  get(sagaId: string): Promise<SagaRecord | null>;
}
