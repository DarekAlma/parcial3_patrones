import type { Backends, ChargingSession, Quote, Reservation, WalletTransaction } from '../clients.js';
import type { SagaStep } from './engine.js';

/**
 * SAGA "Reservar y Activar Carga" (orquestacion).
 *
 *  #  Paso                  Servicio                     Tipo         Compensacion
 *  0  PRICE_QUOTE           billing-wallet-service       compensable  (lectura, nada que deshacer)
 *  1  RESERVE_CONNECTOR     station-reservation-service  compensable  release  -> AVAILABLE
 *  2  CHARGE_WALLET         billing-wallet-service       compensable  refund   -> reembolso + evento REFUND
 *  3  ACTIVATE_CHARGER      energy-dispatch-service      PIVOT        (si falla se compensa 2 y luego 1)
 *  4  CONFIRM_RESERVATION   station-reservation-service  retriable    (se reintenta, no se compensa)
 *
 *  Falla paso 3 (SIMULATE_CHARGER_HARDWARE_FAULT): refund (billing) -> release (station)
 *  Falla paso 2 (INSUFFICIENT_FUNDS):               release (station)
 */
export const SAGA_TYPE = 'RESERVE_AND_ACTIVATE_CHARGE';

export interface ReserveChargeData extends Record<string, unknown> {
  fleetId: string;
  stationId: string;
  connectorId?: string;
  kwh: number;
  priority: boolean;
  quote?: Quote;
  reservation?: Reservation;
  charge?: WalletTransaction;
  session?: ChargingSession;
}

export function reserveChargeSteps(backends: Backends): SagaStep<ReserveChargeData>[] {
  const { stations, billing, dispatch } = backends;
  return [
    {
      name: 'PRICE_QUOTE',
      kind: 'compensable',
      async execute({ sagaId, data }) {
        data.quote = await billing.quote(data.kwh, data.priority ? 'ULTRA' : 'STANDARD', { correlationId: sagaId });
        return {
          detail: {
            amountCents: data.quote.amountCents,
            priceCentsPerKwh: data.quote.priceCentsPerKwh,
            surgeApplied: data.quote.surgeApplied,
          },
        };
      },
    },
    {
      name: 'RESERVE_CONNECTOR',
      kind: 'compensable',
      async execute({ sagaId, data }) {
        data.reservation = await stations.reserve(
          { sagaId, fleetId: data.fleetId, stationId: data.stationId, connectorId: data.connectorId, priority: data.priority },
          { correlationId: sagaId },
        );
        data.connectorId = data.reservation.connectorId;
        return {
          statusAfter: 'RESERVED',
          detail: { connectorId: data.reservation.connectorId, tier: data.reservation.tier, connectorStatus: 'RESERVED' },
        };
      },
      async compensate({ sagaId }) {
        const res = await stations.release(sagaId, 'saga-compensation', { correlationId: sagaId });
        return res.outcome;
      },
    },
    {
      name: 'CHARGE_WALLET',
      kind: 'compensable',
      async execute({ sagaId, data }) {
        const res = await billing.charge(
          {
            sagaId,
            fleetId: data.fleetId,
            amountCents: data.quote!.amountCents,
            description: `Carga ${data.kwh} kWh en ${data.stationId}/${data.connectorId}`,
          },
          { correlationId: sagaId },
        );
        data.charge = res.transaction;
        return { statusAfter: 'CHARGED', detail: { amountCents: res.transaction.amountCents, replayed: res.replayed } };
      },
      async compensate({ sagaId, data }) {
        const res = await billing.refund(sagaId, data.fleetId, 'charger-activation-failed', { correlationId: sagaId });
        return res.outcome;
      },
    },
    {
      name: 'ACTIVATE_CHARGER',
      kind: 'pivot',
      async execute({ sagaId, data }) {
        data.session = await dispatch.start(
          {
            sagaId,
            fleetId: data.fleetId,
            stationId: data.stationId,
            connectorId: data.reservation!.connectorId,
            powerKw: data.reservation!.powerKw,
            kwhTarget: data.kwh,
          },
          { correlationId: sagaId },
        );
        return { detail: { sessionStatus: data.session.status, powerKw: data.session.powerKw } };
      },
    },
    {
      name: 'CONFIRM_RESERVATION',
      kind: 'retriable',
      async execute({ sagaId }) {
        const res = await stations.confirm(sagaId, { correlationId: sagaId });
        return { detail: { reservationStatus: res.status, connectorStatus: 'CHARGING' } };
      },
    },
  ];
}
