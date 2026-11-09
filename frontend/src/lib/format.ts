import type { ConnectorStatus, SagaStatus } from './types';

export const usd = (cents: number | null | undefined) =>
  cents == null ? '—' : (cents / 100).toLocaleString('es-CO', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

export const clock = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '--:--:--';

export const dateShort = (iso: string) =>
  new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: 'short' }).replace('.', '').toUpperCase();

export const ms = (a: string | null, b: string | null) => {
  if (!a || !b) return '';
  const d = new Date(b).getTime() - new Date(a).getTime();
  return d < 1000 ? `${d} ms` : `${(d / 1000).toFixed(1)} s`;
};

/** 69 -> "69 ms", 4200 -> "4,2 s", 607369 -> "10 min 07 s". */
export const duration = (msValue: number) => {
  if (msValue < 1000) return `${msValue} ms`;
  if (msValue < 60_000) return `${(msValue / 1000).toFixed(1).replace('.', ',')} s`;
  const m = Math.floor(msValue / 60_000);
  const s = Math.round((msValue % 60_000) / 1000);
  return `${m} min ${String(s).padStart(2, '0')} s`;
};

export const shortId = (sagaId: string) => sagaId.replace(/^saga-/, '').slice(0, 8).toUpperCase();

export const CONNECTOR_LABEL: Record<ConnectorStatus, string> = {
  AVAILABLE: 'Libre',
  RESERVED: 'Reservado',
  CHARGING: 'Cargando',
  OUT_OF_SERVICE: 'Fuera de servicio',
};

export const SAGA_LABEL: Record<SagaStatus, string> = {
  STARTED: 'Iniciada',
  RESERVED: 'Bahía reservada',
  CHARGED: 'Cobrada',
  COMPLETED: 'Completada',
  COMPENSATING: 'Revirtiendo',
  COMPENSATED: 'Revertida',
  FAILED: 'Requiere atención',
};

export const STEP_LABEL: Record<string, string> = {
  PRICE_QUOTE: 'Cotización de tarifa',
  RESERVE_CONNECTOR: 'Reserva de bahía',
  CHARGE_WALLET: 'Retención de saldo',
  ACTIVATE_CHARGER: 'Activación del cargador',
  CONFIRM_RESERVATION: 'Confirmación de bahía',
};

export const COMPENSATION_LABEL: Record<string, string> = {
  CHARGE_WALLET: 'Reembolso a la billetera',
  RESERVE_CONNECTOR: 'Liberación de la bahía',
};

export const OUTCOME_LABEL: Record<string, string> = {
  REFUNDED: 'reembolsado',
  ALREADY_REFUNDED: 'ya reembolsado',
  NOTHING_TO_REFUND: 'sin cobro',
  RELEASED: 'liberada',
  ALREADY_RELEASED: 'ya liberada',
  NOTHING_TO_RELEASE: 'sin reserva',
};

export const ERROR_LABEL: Record<string, string> = {
  CHARGER_HARDWARE_FAULT: 'El cargador reportó una falla física',
  INSUFFICIENT_FUNDS: 'Fondos insuficientes en la billetera',
  NO_CONNECTOR_AVAILABLE: 'No hay conectores libres de ese tipo',
  CONNECTOR_UNAVAILABLE: 'El conector ya no está libre',
  FEATURE_DISABLED: 'La ultra-carga prioritaria está apagada en este ambiente',
  ORPHANED_SAGA: 'SAGA huérfana recuperada por la auditoría',
};

export const FLAG_COPY: Record<string, { title: string; on: string; off: string }> = {
  ENABLE_DYNAMIC_SURGE_PRICING: {
    title: 'Tarifa dinámica en hora pico',
    on: '×1.5 entre 7–10 h y 17–21 h (Bogotá)',
    off: 'Tarifa base todo el día',
  },
  ENABLE_FAST_CHARGE_BOOST: {
    title: 'Ultra-carga prioritaria',
    on: 'Reservas prioritarias en conectores de 350 kW',
    off: 'Solo reservas estándar',
  },
  SIMULATE_CHARGER_HARDWARE_FAULT: {
    title: 'Simular falla de hardware',
    on: 'Toda activación falla: se dispara el rollback',
    off: 'Cargadores operando normalmente',
  },
};
