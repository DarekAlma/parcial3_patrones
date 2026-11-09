import { describe, expect, it } from 'vitest';
import { effectiveStatus, pickCandidates, SEED_STATIONS, type Connector } from '../src/domain.js';

const now = 1_000_000;
const connector = (over: Partial<Connector>): Connector => ({
  stationId: 's',
  connectorId: 'c',
  type: 'CCS2',
  powerKw: 150,
  tier: 'STANDARD',
  status: 'AVAILABLE',
  ...over,
});

describe('station domain', () => {
  it('un bloqueo RESERVED vencido se considera AVAILABLE (no bloquea la bahia para siempre)', () => {
    expect(effectiveStatus(connector({ status: 'RESERVED', lockExpiresAt: now - 1 }), now)).toBe('AVAILABLE');
    expect(effectiveStatus(connector({ status: 'RESERVED', lockExpiresAt: now + 60 }), now)).toBe('RESERVED');
    expect(effectiveStatus(connector({ status: 'CHARGING' }), now)).toBe('CHARGING');
  });

  it('las reservas prioritarias solo usan conectores ULTRA', () => {
    const list = [
      connector({ connectorId: 'a', tier: 'STANDARD' }),
      connector({ connectorId: 'b', tier: 'ULTRA', powerKw: 350 }),
      connector({ connectorId: 'c', tier: 'ULTRA', status: 'CHARGING' }),
    ];
    expect(pickCandidates(list, true, now).map((c) => c.connectorId)).toEqual(['b']);
    expect(pickCandidates(list, false, now).map((c) => c.connectorId)).toEqual(['a']);
  });

  it('prefiere el conector de mayor potencia y excluye OUT_OF_SERVICE', () => {
    const list = [
      connector({ connectorId: 'slow', powerKw: 50 }),
      connector({ connectorId: 'fast', powerKw: 150 }),
      connector({ connectorId: 'broken', powerKw: 200, status: 'OUT_OF_SERVICE' }),
    ];
    expect(pickCandidates(list, false, now).map((c) => c.connectorId)).toEqual(['fast', 'slow']);
  });

  it('el seed tiene conectores ULTRA en cada estacion', () => {
    for (const s of SEED_STATIONS) expect(s.connectors.some((c) => c.tier === 'ULTRA')).toBe(true);
  });
});
