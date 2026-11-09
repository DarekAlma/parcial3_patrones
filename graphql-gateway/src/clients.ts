import { ServiceClient } from '@aegisvolt/common';

/**
 * Clientes de los microservicios. El gateway solo habla con ellos por HTTP
 * (Service DNS de Kubernetes): nunca toca sus tablas DynamoDB.
 */
export interface Connector {
  stationId: string;
  connectorId: string;
  type: string;
  powerKw: number;
  tier: 'STANDARD' | 'ULTRA';
  status: string;
  reservedBy?: string;
  lockExpiresAt?: number;
}
export interface Station {
  stationId: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lng: number;
  connectors: Connector[];
}
export interface Reservation {
  sagaId: string;
  stationId: string;
  connectorId: string;
  tier: 'STANDARD' | 'ULTRA';
  powerKw: number;
  status: string;
}
export interface Quote {
  kwh: number;
  tier: 'STANDARD' | 'ULTRA';
  basePriceCentsPerKwh: number;
  priceCentsPerKwh: number;
  surgeEnabled: boolean;
  isPeakHour: boolean;
  surgeApplied: boolean;
  surgeMultiplier: number;
  amountCents: number;
  currency: string;
  localHour: number;
}
export interface WalletTransaction {
  sagaId: string;
  fleetId: string;
  type: 'CHARGE' | 'REFUND';
  amountCents: number;
  description: string;
  createdAt: string;
}
export interface Wallet {
  fleetId: string;
  fleetName: string;
  balanceCents: number;
  currency: string;
}
export interface ChargingSession {
  sagaId: string;
  stationId: string;
  connectorId: string;
  powerKw: number;
  kwhTarget: number;
  kwhDelivered: number;
  status: string;
  faultCode?: string;
  startedAt: string;
  updatedAt: string;
}

type Opts = { correlationId: string };

export class StationApi {
  constructor(private readonly http: ServiceClient) {}
  listStations(o: Opts) {
    return this.http.call<Station[]>('GET', '/stations', undefined, o);
  }
  getStation(id: string, o: Opts) {
    return this.http.call<Station>('GET', `/stations/${encodeURIComponent(id)}`, undefined, o);
  }
  reserve(body: { sagaId: string; fleetId: string; stationId: string; connectorId?: string; priority: boolean }, o: Opts) {
    return this.http.call<Reservation>('POST', '/reservations', body, { ...o, retries: 2 });
  }
  release(sagaId: string, reason: string, o: Opts) {
    return this.http.call<{ outcome: string }>('POST', `/reservations/${sagaId}/release`, { reason }, { ...o, retries: 0 });
  }
  confirm(sagaId: string, o: Opts) {
    return this.http.call<Reservation>('POST', `/reservations/${sagaId}/confirm`, {}, { ...o, retries: 0 });
  }
}

export class BillingApi {
  constructor(private readonly http: ServiceClient) {}
  listWallets(o: Opts) {
    return this.http.call<Wallet[]>('GET', '/wallets', undefined, o);
  }
  getWallet(fleetId: string, o: Opts) {
    return this.http.call<Wallet>('GET', `/wallets/${encodeURIComponent(fleetId)}`, undefined, o);
  }
  transactions(fleetId: string, limit: number, o: Opts) {
    return this.http.call<WalletTransaction[]>('GET', `/wallets/${encodeURIComponent(fleetId)}/transactions?limit=${limit}`, undefined, o);
  }
  topUp(fleetId: string, amountCents: number, o: Opts) {
    return this.http.call<Wallet>('POST', `/wallets/${encodeURIComponent(fleetId)}/top-up`, { amountCents }, o);
  }
  quote(kwh: number, tier: 'STANDARD' | 'ULTRA', o: Opts) {
    return this.http.call<Quote>('POST', '/quotes', { kwh, tier }, o);
  }
  charge(body: { sagaId: string; fleetId: string; amountCents: number; description: string }, o: Opts) {
    return this.http.call<{ transaction: WalletTransaction; replayed: boolean }>('POST', '/charges', body, { ...o, retries: 2 });
  }
  refund(sagaId: string, fleetId: string, reason: string, o: Opts) {
    return this.http.call<{ outcome: string }>('POST', `/charges/${sagaId}/refund`, { fleetId, reason }, { ...o, retries: 0 });
  }
}

export class DispatchApi {
  constructor(private readonly http: ServiceClient) {}
  start(
    body: { sagaId: string; fleetId: string; stationId: string; connectorId: string; powerKw: number; kwhTarget: number },
    o: Opts,
  ) {
    return this.http.call<ChargingSession>('POST', '/sessions', body, { ...o, retries: 2 });
  }
  sessions(status: string | undefined, o: Opts) {
    return this.http.call<ChargingSession[]>('GET', `/sessions${status ? `?status=${status}` : ''}`, undefined, o);
  }
  telemetry(stationId: string, limit: number, o: Opts) {
    return this.http.call<unknown[]>('GET', `/telemetry/${encodeURIComponent(stationId)}?limit=${limit}`, undefined, o);
  }
}

export interface Backends {
  stations: StationApi;
  billing: BillingApi;
  dispatch: DispatchApi;
}

export function createBackends(urls: { station: string; billing: string; dispatch: string }): Backends {
  return {
    stations: new StationApi(new ServiceClient('station-reservation-service', urls.station)),
    billing: new BillingApi(new ServiceClient('billing-wallet-service', urls.billing)),
    dispatch: new DispatchApi(new ServiceClient('energy-dispatch-service', urls.dispatch)),
  };
}
