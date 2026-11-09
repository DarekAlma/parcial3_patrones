import { RemoteError } from './errors.js';
import { CORRELATION_HEADER } from './server.js';

export interface CallOptions {
  correlationId: string;
  timeoutMs?: number;
  /** Reintentos ante errores de red/5xx. Seguro porque toda operacion es idempotente por sagaId. */
  retries?: number;
}

/**
 * Cliente HTTP entre servicios: timeout, reintentos con backoff exponencial y
 * propagacion del correlation_id. Errores de dominio (4xx) no se reintentan.
 */
export class ServiceClient {
  constructor(
    private readonly service: string,
    private readonly baseUrl: string,
  ) {}

  async call<T>(method: 'GET' | 'POST', path: string, body: unknown, options: CallOptions): Promise<T> {
    const retries = options.retries ?? 2;
    let lastError: RemoteError | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(100 * 2 ** (attempt - 1));
      try {
        return await this.once<T>(method, path, body, options);
      } catch (err) {
        lastError =
          err instanceof RemoteError
            ? err
            : new RemoteError(this.service, 0, 'NETWORK_ERROR', (err as Error).message, true);
        if (!lastError.retryable) throw lastError;
      }
    }
    throw lastError!;
  }

  private async once<T>(method: string, path: string, body: unknown, options: CallOptions): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', [CORRELATION_HEADER]: options.correlationId },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
    const text = await res.text();
    const payload = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new RemoteError(
        this.service,
        res.status,
        payload.code ?? 'REMOTE_ERROR',
        payload.message ?? res.statusText,
        res.status >= 500 && payload.code !== 'CHARGER_HARDWARE_FAULT',
      );
    }
    return payload as T;
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
