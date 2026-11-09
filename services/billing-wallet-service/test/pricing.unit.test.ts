import { describe, expect, it } from 'vitest';
import { isPeak, localHour, parsePeakHours, quote } from '../src/pricing.js';

const peakHours = parsePeakHours('7-10,17-21');
const tz = 'America/Bogota';
// 18:00 en Bogota (UTC-5) = 23:00 UTC => hora pico. 13:00 Bogota = 18:00 UTC => valle.
const peak = new Date('2026-11-09T23:00:00Z');
const offPeak = new Date('2026-11-09T18:00:00Z');

describe('pricing - ENABLE_DYNAMIC_SURGE_PRICING', () => {
  it('interpreta los rangos de horas pico', () => {
    expect(peakHours).toEqual([
      [7, 10],
      [17, 21],
    ]);
    expect(isPeak(17, peakHours)).toBe(true);
    expect(isPeak(21, peakHours)).toBe(false);
    expect(localHour(peak, tz)).toBe(18);
  });

  it('flag activa + hora pico => multiplicador 1.5', () => {
    const q = quote({ kwh: 40, tier: 'STANDARD' }, { surgeEnabled: true, now: peak, peakHours, timeZone: tz });
    expect(q).toMatchObject({ isPeakHour: true, surgeApplied: true, surgeMultiplier: 1.5, priceCentsPerKwh: 53, amountCents: 2120 });
  });

  it('flag activa fuera de hora pico => tarifa base', () => {
    const q = quote({ kwh: 40, tier: 'STANDARD' }, { surgeEnabled: true, now: offPeak, peakHours, timeZone: tz });
    expect(q).toMatchObject({ isPeakHour: false, surgeApplied: false, amountCents: 1400 });
  });

  it('flag apagada (prod) => nunca aplica surge, ni en hora pico', () => {
    const q = quote({ kwh: 40, tier: 'ULTRA' }, { surgeEnabled: false, now: peak, peakHours, timeZone: tz });
    expect(q).toMatchObject({ isPeakHour: true, surgeApplied: false, priceCentsPerKwh: 55, amountCents: 2200 });
  });

  it('rechaza cantidades de energia invalidas', () => {
    expect(() => quote({ kwh: 0, tier: 'STANDARD' }, { surgeEnabled: false, now: peak, peakHours, timeZone: tz })).toThrow();
    expect(() => parsePeakHours('7-x')).toThrow();
  });
});
