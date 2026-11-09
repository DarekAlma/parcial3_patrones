/**
 * Tarifacion de la energia. Logica pura (sin I/O) => facil de probar.
 *
 * ENABLE_DYNAMIC_SURGE_PRICING: en horas pico (zona America/Bogota) el precio
 * por kWh se multiplica por SURGE_MULTIPLIER. Fuera de horas pico, o con la
 * flag apagada, se cobra la tarifa base.
 */
export type Tier = 'STANDARD' | 'ULTRA';

export const BASE_PRICE_CENTS_PER_KWH: Record<Tier, number> = { STANDARD: 35, ULTRA: 55 };
export const SURGE_MULTIPLIER = 1.5;

export interface QuoteInput {
  kwh: number;
  tier: Tier;
}

export interface Quote {
  kwh: number;
  tier: Tier;
  basePriceCentsPerKwh: number;
  priceCentsPerKwh: number;
  surgeEnabled: boolean;
  isPeakHour: boolean;
  surgeApplied: boolean;
  surgeMultiplier: number;
  amountCents: number;
  currency: 'USD';
  localHour: number;
}

/** Rangos "7-10,17-21" => horas [7,10) y [17,21). */
export function parsePeakHours(spec: string): [number, number][] {
  return spec
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [from, to] = r.split('-').map(Number);
      if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error(`Rango de horas pico invalido: ${r}`);
      return [from!, to!] as [number, number];
    });
}

export function localHour(date: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(date);
  return Number(hour);
}

export function isPeak(hour: number, ranges: [number, number][]): boolean {
  return ranges.some(([from, to]) => hour >= from && hour < to);
}

export function quote(
  input: QuoteInput,
  opts: { surgeEnabled: boolean; now: Date; peakHours: [number, number][]; timeZone: string },
): Quote {
  if (!(input.kwh > 0) || input.kwh > 500) throw new Error('kwh debe estar entre 0 y 500');
  const base = BASE_PRICE_CENTS_PER_KWH[input.tier];
  const hour = localHour(opts.now, opts.timeZone);
  const peak = isPeak(hour, opts.peakHours);
  const surgeApplied = opts.surgeEnabled && peak;
  const multiplier = surgeApplied ? SURGE_MULTIPLIER : 1;
  const price = Math.round(base * multiplier);
  return {
    kwh: input.kwh,
    tier: input.tier,
    basePriceCentsPerKwh: base,
    priceCentsPerKwh: price,
    surgeEnabled: opts.surgeEnabled,
    isPeakHour: peak,
    surgeApplied,
    surgeMultiplier: multiplier,
    amountCents: Math.ceil(input.kwh * price),
    currency: 'USD',
    localHour: hour,
  };
}
