import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Cliente GraphQL minimo. El frontend se sirve detras del MISMO API Gateway
 * del ambiente, asi que /graphql es del mismo origen (sin CORS).
 * Para comparar flags entre ambientes se le pasa la URL base de otro ambiente.
 */
export class GraphQLError extends Error {}

export interface GqlOptions {
  /** Obligatorio cuando el documento trae varias operaciones. */
  operationName?: string;
  /** URL base de otro ambiente (comparacion de flags). Vacio = mismo origen. */
  baseUrl?: string;
}

export async function gql<T>(query: string, variables?: Record<string, unknown>, opts: GqlOptions = {}): Promise<T> {
  const res = opts.baseUrl ? await crossOriginQuery(opts.baseUrl, query, variables, opts.operationName) : await fetch('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables, operationName: opts.operationName }),
  });
  if (!res.ok && res.status !== 200) throw new GraphQLError(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new GraphQLError(body.errors.map((e) => e.message).join('; '));
  return body.data as T;
}

/**
 * Lectura en OTRO ambiente (otro origen). Se envia como GET sin cabeceras
 * propias: es una "simple request" de CORS y no dispara el preflight OPTIONS
 * (el API Gateway de Floci responde 500 al preflight). La respuesta trae
 * Access-Control-Allow-Origin. Solo para queries: una mutation nunca va por GET.
 */
function crossOriginQuery(baseUrl: string, query: string, variables?: Record<string, unknown>, operationName?: string) {
  const params = new URLSearchParams({ query });
  if (variables) params.set('variables', JSON.stringify(variables));
  if (operationName) params.set('operationName', operationName);
  return fetch(`${baseUrl}/graphql?${params.toString()}`);
}

/**
 * "Tiempo real" por polling: la API no expone subscriptions. Se pausa con la
 * pestana oculta y se reanuda al volver; refresh() fuerza una lectura.
 */
export function usePoll<T>(
  query: string,
  variables: Record<string, unknown> | undefined,
  intervalMs: number,
  enabled = true,
  operationName?: string,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastOk, setLastOk] = useState<number | null>(null);
  const key = JSON.stringify(variables ?? {});
  const vars = useRef(variables);
  vars.current = variables;

  const refresh = useCallback(async () => {
    try {
      const result = await gql<T>(query, vars.current, { operationName });
      setData(result);
      setError(null);
      setLastOk(Date.now());
    } catch (err) {
      setError((err as Error).message);
    }
  }, [query, key, operationName]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    let timer = window.setInterval(() => document.visibilityState === 'visible' && void refresh(), intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
        window.clearInterval(timer);
        timer = window.setInterval(() => document.visibilityState === 'visible' && void refresh(), intervalMs);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, intervalMs, enabled]);

  return { data, error, lastOk, refresh };
}
