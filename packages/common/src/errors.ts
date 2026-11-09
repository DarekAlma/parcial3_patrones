/**
 * Error de dominio con codigo estable y status HTTP. Los servicios lo lanzan y
 * el servidor HTTP comun lo serializa como { code, message, details }.
 * El orquestador de la SAGA decide compensar o no segun el code.
 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** Error al llamar a otro servicio (timeout, 5xx o respuesta de error de dominio). */
export class RemoteError extends Error {
  constructor(
    public readonly service: string,
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'RemoteError';
  }
}

export function isConditionalCheckFailed(err: unknown): boolean {
  return (err as { name?: string })?.name === 'ConditionalCheckFailedException';
}

/**
 * TransactWriteItems cancelada: devuelve el motivo de cada item en orden
 * (p. ej. ['ConditionalCheckFailed', 'None']) para saber cual condicion fallo.
 */
export function transactionCancellationReasons(err: unknown): string[] | null {
  const e = err as { name?: string; CancellationReasons?: { Code?: string }[] };
  if (e?.name !== 'TransactionCanceledException') return null;
  return (e.CancellationReasons ?? []).map((r) => r.Code ?? 'None');
}
