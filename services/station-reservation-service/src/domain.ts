/**
 * Dominio de station-reservation-service: electrolineras, conectores y reservas.
 *
 * Modelo en la tabla aegisvolt-reservations-<env> (pk/sk + gsi1):
 *   STATION#<id>      | META                   estacion          gsi1: STATION   / <id>
 *   STATION#<id>      | CONNECTOR#<cid>        conector          gsi1: CONNECTOR / <id>#<cid>
 *   RESERVATION#<sid> | META                   reserva de SAGA   (TTL expiresAt mientras esta HELD)
 */
export type ConnectorStatus = 'AVAILABLE' | 'RESERVED' | 'CHARGING' | 'OUT_OF_SERVICE';
export type ConnectorTier = 'STANDARD' | 'ULTRA';
export type ReservationStatus = 'HELD' | 'CONFIRMED' | 'RELEASED' | 'COMPLETED';

export interface Connector {
  stationId: string;
  connectorId: string;
  type: 'CCS2' | 'CHADEMO' | 'TYPE2';
  powerKw: number;
  tier: ConnectorTier;
  status: ConnectorStatus;
  reservedBy?: string;
  lockExpiresAt?: number;
  updatedAt?: string;
}

export interface Station {
  stationId: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lng: number;
}

export interface StationView extends Station {
  connectors: Connector[];
}

export interface Reservation {
  sagaId: string;
  fleetId: string;
  stationId: string;
  connectorId: string;
  priority: boolean;
  tier: ConnectorTier;
  powerKw: number;
  status: ReservationStatus;
  createdAt: string;
  updatedAt: string;
  releaseReason?: string;
  expiresAt?: number;
}

export interface ReserveInput {
  sagaId: string;
  fleetId: string;
  stationId: string;
  connectorId?: string;
  priority?: boolean;
}

/**
 * Estado efectivo: un bloqueo RESERVED vencido se considera AVAILABLE. Asi una
 * reserva cuya SAGA murio sin compensar no bloquea la bahia para siempre.
 */
export function effectiveStatus(connector: Connector, nowSeconds: number): ConnectorStatus {
  if (connector.status === 'RESERVED' && (connector.lockExpiresAt ?? 0) < nowSeconds) return 'AVAILABLE';
  return connector.status;
}

/** Elige conectores candidatos: los prioritarios usan ultra-carga (ULTRA). */
export function pickCandidates(connectors: Connector[], priority: boolean, nowSeconds: number): Connector[] {
  const tier: ConnectorTier = priority ? 'ULTRA' : 'STANDARD';
  return connectors
    .filter((c) => c.tier === tier && effectiveStatus(c, nowSeconds) === 'AVAILABLE')
    .sort((a, b) => b.powerKw - a.powerKw);
}

export const SEED_STATIONS: StationView[] = [
  {
    stationId: 'st-bog-norte',
    name: 'Electrolinera Bogotá Norte',
    city: 'Bogotá',
    country: 'CO',
    lat: 4.7569,
    lng: -74.0466,
    connectors: [
      { stationId: 'st-bog-norte', connectorId: 'c1', type: 'CCS2', powerKw: 150, tier: 'STANDARD', status: 'AVAILABLE' },
      { stationId: 'st-bog-norte', connectorId: 'c2', type: 'CCS2', powerKw: 150, tier: 'STANDARD', status: 'AVAILABLE' },
      { stationId: 'st-bog-norte', connectorId: 'c3', type: 'CCS2', powerKw: 350, tier: 'ULTRA', status: 'AVAILABLE' },
      { stationId: 'st-bog-norte', connectorId: 'c4', type: 'CHADEMO', powerKw: 50, tier: 'STANDARD', status: 'AVAILABLE' },
    ],
  },
  {
    stationId: 'st-med-poblado',
    name: 'Hub Logístico Medellín El Poblado',
    city: 'Medellín',
    country: 'CO',
    lat: 6.2087,
    lng: -75.5674,
    connectors: [
      { stationId: 'st-med-poblado', connectorId: 'c1', type: 'CCS2', powerKw: 120, tier: 'STANDARD', status: 'AVAILABLE' },
      { stationId: 'st-med-poblado', connectorId: 'c2', type: 'CCS2', powerKw: 350, tier: 'ULTRA', status: 'AVAILABLE' },
      { stationId: 'st-med-poblado', connectorId: 'c3', type: 'TYPE2', powerKw: 22, tier: 'STANDARD', status: 'OUT_OF_SERVICE' },
    ],
  },
  {
    stationId: 'st-cdmx-vallejo',
    name: 'Centro de Carga CDMX Vallejo',
    city: 'Ciudad de México',
    country: 'MX',
    lat: 19.4883,
    lng: -99.1611,
    connectors: [
      { stationId: 'st-cdmx-vallejo', connectorId: 'c1', type: 'CCS2', powerKw: 180, tier: 'STANDARD', status: 'AVAILABLE' },
      { stationId: 'st-cdmx-vallejo', connectorId: 'c2', type: 'CCS2', powerKw: 180, tier: 'STANDARD', status: 'AVAILABLE' },
      { stationId: 'st-cdmx-vallejo', connectorId: 'c3', type: 'CCS2', powerKw: 350, tier: 'ULTRA', status: 'AVAILABLE' },
    ],
  },
];
