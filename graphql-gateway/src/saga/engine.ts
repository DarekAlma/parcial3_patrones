import { RemoteError, sleep, type Logger } from '@aegisvolt/common';
import {
  TERMINAL_STATUSES,
  type SagaRecord,
  type SagaStatus,
  type SagaStore,
  type StepKind,
  type StepRecord,
} from './types.js';

/**
 * Motor generico de SAGA por ORQUESTACION.
 *
 * El orquestador (este proceso) conoce la secuencia completa, invoca a cada
 * servicio y, si un paso falla, ejecuta las compensaciones de los pasos ya
 * completados en ORDEN INVERSO. El estado de cada transicion se persiste en
 * DynamoDB antes de continuar: si el pod muere a mitad de camino, el log dice
 * exactamente que paso quedo hecho y que compensar (ver recover()).
 */
export interface StepContext<D> {
  sagaId: string;
  data: D;
}

export interface StepResult {
  /** Detalle que queda en el log de la SAGA (visible en UI y en Prefect). */
  detail?: Record<string, unknown>;
  /** Estado de la SAGA tras completar el paso. */
  statusAfter?: SagaStatus;
}

export interface SagaStep<D> {
  name: string;
  kind: StepKind;
  execute(ctx: StepContext<D>): Promise<StepResult | void>;
  /** Debe ser IDEMPOTENTE: puede ejecutarse mas de una vez. Devuelve el outcome. */
  compensate?(ctx: StepContext<D>): Promise<string | void>;
}

export interface EngineOptions {
  compensationAttempts: number;
  retriableAttempts: number;
  backoffMs: number;
  now?: () => Date;
}

export class SagaEngine {
  constructor(
    private readonly store: SagaStore,
    private readonly logger: Logger,
    private readonly options: EngineOptions = { compensationAttempts: 4, retriableAttempts: 4, backoffMs: 200 },
  ) {}

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  /**
   * Ejecuta la SAGA. Si el sagaId ya existe (mismo idempotencyKey) NO se vuelve
   * a ejecutar: se devuelve el registro existente.
   */
  async run<D extends Record<string, unknown>>(
    sagaId: string,
    type: string,
    environment: string,
    input: Record<string, unknown>,
    steps: SagaStep<D>[],
    initialData: D,
  ): Promise<SagaRecord> {
    const log = this.logger.child({ correlation_id: sagaId, saga_id: sagaId, saga_type: type });
    const createdAt = this.now();
    const record: SagaRecord = {
      sagaId,
      type,
      status: 'STARTED',
      environment,
      input,
      data: initialData,
      steps: steps.map((s) => ({ name: s.name, kind: s.kind, status: 'PENDING', attempts: 0 })),
      compensations: [],
      createdAt,
      updatedAt: createdAt,
      version: 0,
    };

    const created = await this.store.create(record);
    if (!created) {
      const existing = await this.store.get(sagaId);
      log.info('saga replayed (idempotent)', { event: 'saga_replayed', status: existing?.status });
      return existing!;
    }
    log.info('saga started', { event: 'saga_started', input });

    const ctx: StepContext<D> = { sagaId, data: initialData };

    for (const [index, step] of steps.entries()) {
      const stepRecord = record.steps[index]!;
      try {
        const result = await this.executeStep(step, stepRecord, ctx, record, log);
        if (result?.statusAfter) record.status = result.statusAfter;
        await this.persist(record, ctx);
      } catch (err) {
        const failure = describe(err);
        stepRecord.status = 'FAILED';
        stepRecord.finishedAt = this.now();
        stepRecord.error = failure.message;
        record.error = { step: step.name, ...failure };
        log.warn('saga step failed', { event: 'saga_step_failed', step: step.name, code: failure.code, reason: failure.message });

        if (step.kind === 'retriable') {
          // Despues del pivot no se compensa: queda marcada para intervencion/auditoria.
          record.status = 'FAILED';
          record.completedAt = this.now();
          await this.persist(record, ctx);
          log.error('saga failed after pivot', { event: 'saga_failed', step: step.name, code: failure.code });
          return record;
        }
        return this.compensate(record, steps, ctx, log);
      }
    }

    record.status = 'COMPLETED';
    record.completedAt = this.now();
    await this.persist(record, ctx);
    log.info('saga completed', { event: 'saga_completed', duration_ms: elapsed(record) });
    return record;
  }

  private async executeStep<D>(
    step: SagaStep<D>,
    stepRecord: StepRecord,
    ctx: StepContext<D>,
    record: SagaRecord,
    log: Logger,
  ): Promise<StepResult | void> {
    const maxAttempts = step.kind === 'retriable' ? this.options.retriableAttempts : 1;
    stepRecord.status = 'RUNNING';
    stepRecord.startedAt = this.now();
    await this.persist(record, ctx);
    log.info('saga step started', { event: 'saga_step_started', step: step.name, kind: step.kind });

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      stepRecord.attempts = attempt;
      try {
        const result = await step.execute(ctx);
        stepRecord.status = 'SUCCEEDED';
        stepRecord.finishedAt = this.now();
        stepRecord.detail = result?.detail;
        log.info('saga step succeeded', { event: 'saga_step_succeeded', step: step.name, attempt });
        return result;
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts) await sleep(this.options.backoffMs * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }

  /**
   * Ejecuta las compensaciones de los pasos SUCCEEDED en orden inverso.
   * Cada compensacion se reintenta con backoff exponencial; como los endpoints
   * son idempotentes, reintentar nunca duplica un reembolso ni una liberacion.
   */
  async compensate<D>(record: SagaRecord, steps: SagaStep<D>[], ctx: StepContext<D>, log: Logger): Promise<SagaRecord> {
    record.status = 'COMPENSATING';
    await this.persist(record, ctx);
    log.info('saga compensation started', { event: 'saga_compensation_started', failed_step: record.error?.step });

    let allOk = true;
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i]!;
      const stepRecord = record.steps[i]!;
      const alreadyDone = record.compensations.some((c) => c.step === step.name && c.status === 'SUCCEEDED');
      // SUCCEEDED: hay que deshacerlo. COMPENSATING/COMPENSATION_FAILED: una
      // compensacion previa quedo a medias (crash o fallo) y se reintenta.
      if (!['SUCCEEDED', 'COMPENSATING', 'COMPENSATION_FAILED'].includes(stepRecord.status)) continue;
      if (!step.compensate || alreadyDone) continue;

      stepRecord.status = 'COMPENSATING';
      await this.persist(record, ctx);

      let attempts = 0;
      let outcome: string | void = undefined;
      let error: string | undefined;
      while (attempts < this.options.compensationAttempts) {
        attempts++;
        try {
          outcome = await step.compensate(ctx);
          error = undefined;
          break;
        } catch (err) {
          error = describe(err).message;
          log.warn('compensation attempt failed', { event: 'saga_compensation_retry', step: step.name, attempt: attempts, reason: error });
          if (attempts < this.options.compensationAttempts) await sleep(this.options.backoffMs * 2 ** (attempts - 1));
        }
      }

      const ok = error === undefined;
      allOk &&= ok;
      stepRecord.status = ok ? 'COMPENSATED' : 'COMPENSATION_FAILED';
      record.compensations.push({ step: step.name, status: ok ? 'SUCCEEDED' : 'FAILED', attempts, outcome: outcome ?? undefined, at: this.now(), error });
      await this.persist(record, ctx);
      log.info(ok ? 'compensation succeeded' : 'compensation failed', {
        event: ok ? 'saga_compensation_succeeded' : 'saga_compensation_failed',
        step: step.name,
        attempts,
        outcome,
      });
    }

    record.status = allOk ? 'COMPENSATED' : 'FAILED';
    record.completedAt = this.now();
    await this.persist(record, ctx);
    if (allOk) {
      log.info('saga compensated', { event: 'saga_compensated', failed_step: record.error?.step, compensations: record.compensations.length });
    } else {
      log.error('saga failed: compensation incomplete', { event: 'saga_failed', failed_step: record.error?.step });
    }
    return record;
  }

  /**
   * Recupera una SAGA huerfana (no terminal, p. ej. el pod murio a mitad de
   * camino): compensa lo que haya quedado hecho. Lo usa la auditoria de Prefect.
   */
  async recover<D>(sagaId: string, steps: SagaStep<D>[]): Promise<SagaRecord | null> {
    const record = await this.store.get(sagaId);
    if (!record) return null;
    const log = this.logger.child({ correlation_id: sagaId, saga_id: sagaId });
    const retryingFailed = record.status === 'FAILED' && record.steps.some((s) => s.status === 'COMPENSATION_FAILED');
    if (TERMINAL_STATUSES.includes(record.status) && !retryingFailed) return record;

    record.error ??= { step: 'RECOVERY', code: 'ORPHANED_SAGA', message: 'SAGA sin terminar recuperada por auditoria' };
    for (const s of record.steps) if (s.status === 'RUNNING') s.status = 'FAILED';
    log.warn('recovering orphaned saga', { event: 'saga_recovery_started', status: record.status });
    return this.compensate(record, steps, { sagaId, data: record.data as D }, log);
  }

  private async persist<D>(record: SagaRecord, ctx: StepContext<D>): Promise<void> {
    record.data = ctx.data as Record<string, unknown>;
    record.updatedAt = this.now();
    await this.store.save(record);
  }
}

function describe(err: unknown): { code: string; message: string } {
  if (err instanceof RemoteError) return { code: err.code, message: `${err.service}: ${err.message}` };
  const e = err as { code?: string; message?: string };
  return { code: e?.code ?? 'UNEXPECTED_ERROR', message: e?.message ?? String(err) };
}

function elapsed(record: SagaRecord): number {
  return new Date(record.updatedAt).getTime() - new Date(record.createdAt).getTime();
}
