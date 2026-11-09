import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FeatureFlagClient, FLAGS, RemoteError, ServiceClient, createMemoryLogger } from '../src/index.js';

describe('FeatureFlagClient', () => {
  it('cachea por unos segundos y luego relee DynamoDB (cambio sin redeploy)', async () => {
    let enabled = false;
    const send = vi.fn(async () => ({ Item: { flag: FLAGS.SIMULATE_CHARGER_HARDWARE_FAULT, enabled } }));
    const client = new FeatureFlagClient({ send } as unknown as DynamoDBDocumentClient, 'flags', 50);

    expect(await client.isEnabled(FLAGS.SIMULATE_CHARGER_HARDWARE_FAULT)).toBe(false);
    enabled = true;
    expect(await client.isEnabled(FLAGS.SIMULATE_CHARGER_HARDWARE_FAULT)).toBe(false); // cache
    await new Promise((r) => setTimeout(r, 60));
    expect(await client.isEnabled(FLAGS.SIMULATE_CHARGER_HARDWARE_FAULT)).toBe(true); // releido
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('si DynamoDB falla usa el ultimo valor conocido o el default', async () => {
    const send = vi.fn().mockRejectedValue(new Error('down'));
    const client = new FeatureFlagClient({ send } as unknown as DynamoDBDocumentClient, 'flags', 0, {
      ENABLE_FAST_CHARGE_BOOST: true,
    });
    expect(await client.isEnabled(FLAGS.ENABLE_FAST_CHARGE_BOOST)).toBe(true);
    expect(await client.isEnabled(FLAGS.ENABLE_DYNAMIC_SURGE_PRICING)).toBe(false);
  });
});

describe('ServiceClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('reintenta errores 5xx y propaga el correlation_id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(503, { code: 'UNAVAILABLE' }))
      .mockResolvedValueOnce(respond(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await new ServiceClient('svc', 'http://svc').call('POST', '/x', {}, { correlationId: 'saga-1', retries: 2 });
    expect(res).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![1].headers['x-correlation-id']).toBe('saga-1');
  });

  it('NO reintenta errores de dominio 4xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(402, { code: 'INSUFFICIENT_FUNDS', message: 'sin fondos' }));
    vi.stubGlobal('fetch', fetchMock);

    const err = await new ServiceClient('billing', 'http://b')
      .call('POST', '/charges', {}, { correlationId: 's', retries: 3 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe('INSUFFICIENT_FUNDS');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Logger', () => {
  it('emite JSON con service, environment, track y correlation_id', () => {
    const { logger, entries } = createMemoryLogger();
    logger.child({ correlation_id: 'saga-9' }).error('boom', { event: 'saga_failed' });
    expect(entries[0]).toMatchObject({ level: 'ERROR', correlation_id: 'saga-9', event: 'saga_failed', track: 'stable' });
  });
});
