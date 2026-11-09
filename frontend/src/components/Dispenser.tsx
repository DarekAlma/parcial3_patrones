import { useEffect, useMemo, useState } from 'react';
import QUOTE from '../graphql/Quote.graphql?raw';
import TRANSACTIONS from '../graphql/Transactions.graphql?raw';
import { gql } from '../lib/graphql';
import { CONNECTOR_LABEL, usd } from '../lib/format';
import type { ChargeTransaction, Connector, Quote, Station, TelemetryPoint, Wallet } from '../lib/types';
import { IconBolt, IconKey, IconLock, IconNozzleCCS, IconNozzleChademo } from './Icons';
import { Lcd, pad } from './Lcd';

const PRESETS = [10, 20, 40, 60];

interface Props {
  station: Station;
  telemetry: TelemetryPoint[];
  wallets: Wallet[];
  boostEnabled: boolean;
  surgeEnabled: boolean;
  onTicket: (tx: ChargeTransaction) => void;
  onAfterCharge: () => void;
}

/**
 * El surtidor: placa de la estacion, display LCD vivo, mangueras (conectores)
 * y el teclado de autorizacion que dispara la SAGA reserveAndActivateCharge.
 */
export function Dispenser({ station, telemetry, wallets, boostEnabled, surgeEnabled, onTicket, onAfterCharge }: Props) {
  const [fleetId, setFleetId] = useState<string>('');
  const [kwh, setKwh] = useState(20);
  const [priority, setPriority] = useState(false);
  const [connectorId, setConnectorId] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!fleetId && wallets[0]) setFleetId(wallets[0].fleetId);
  }, [wallets, fleetId]);

  useEffect(() => {
    setConnectorId(null);
    setError(null);
  }, [station.id]);

  useEffect(() => {
    if (!boostEnabled) setPriority(false);
  }, [boostEnabled]);

  // Cotizacion en vivo (aplica ENABLE_DYNAMIC_SURGE_PRICING del ambiente).
  useEffect(() => {
    let cancelled = false;
    const t = window.setTimeout(() => {
      gql<{ quote: Quote }>(QUOTE, { kwh, priority })
        .then((d) => !cancelled && setQuote(d.quote))
        .catch(() => !cancelled && setQuote(null));
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [kwh, priority, surgeEnabled]);

  const latestByConnector = useMemo(() => {
    const map = new Map<string, TelemetryPoint>();
    for (const p of telemetry) if (!map.has(p.connectorId)) map.set(p.connectorId, p);
    return map;
  }, [telemetry]);

  const live = useMemo(() => {
    const charging = station.connectors.filter((c) => c.status === 'CHARGING');
    const focus = connectorId ? station.connectors.find((c) => c.id === connectorId) : charging[0];
    return focus ? { connector: focus, point: latestByConnector.get(focus.id) } : null;
  }, [station, connectorId, latestByConnector]);

  const wallet = wallets.find((w) => w.fleetId === fleetId);
  const selectable = (c: Connector) => c.status === 'AVAILABLE' && (priority ? c.tier === 'ULTRA' : c.tier === 'STANDARD');
  const free = station.connectors.filter(selectable).length;
  const canAuthorize = !busy && !!fleetId && free > 0 && (!connectorId || selectable(station.connectors.find((c) => c.id === connectorId)!));

  async function authorize() {
    setBusy(true);
    setError(null);
    try {
      const input = { fleetId, stationId: station.id, kwh, priority, ...(connectorId ? { connectorId } : {}) };
      const data = await gql<{ reserveAndActivateCharge: ChargeTransaction }>(TRANSACTIONS, { input }, { operationName: 'ReserveAndActivateCharge' });
      onTicket(data.reserveAndActivateCharge);
      setConnectorId(null);
      onAfterCharge();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const showLive = live?.connector.status === 'CHARGING' && live.point;
  return (
    <section className="dispenser" aria-labelledby="dispenser-title">
      <div className="dispenser-crown">
        <h2 id="dispenser-title">{station.name}</h2>
        <span className="crown-city">
          {station.city} · {station.country}
        </span>
        <span className="crown-number">{station.id.replace('st-', '').toUpperCase()}</span>
      </div>

      <div className="dispenser-glass">
        {showLive ? (
          <>
            <Lcd size="xl" label={`Manguera ${live!.connector.id.toUpperCase()} · entregando`} value={pad(live!.point!.powerKw, 3, 1)} unit="kW" />
            <div className="glass-row">
              <Lcd size="md" label="Energía" value={pad(live!.point!.kwhDelivered, 3, 2)} unit="kWh" />
              <Lcd size="md" label="Batería" value={pad(live!.point!.socPercent, 3, 0)} unit="%" />
              <Lcd size="md" label="Tensión" value={pad(live!.point!.voltageV, 3, 0)} unit="V" />
              <Lcd size="md" label="Temp." value={pad(live!.point!.temperatureC, 2, 1)} unit="°C" />
            </div>
          </>
        ) : (
          <>
            <Lcd size="xl" label="Total estimado" value={quote ? pad(quote.amountCents / 100, 3, 2) : '!!!.!!'} unit="USD" />
            <div className="glass-row">
              <Lcd size="md" label="Energía" value={pad(kwh, 3, 0)} unit="kWh" />
              <Lcd size="md" label="Tarifa" value={quote ? pad(quote.priceCentsPerKwh / 100, 1, 2) : '!.!!'} unit="USD/kWh" />
              <div className={`surge-tag${quote?.surgeApplied ? ' surge-on' : ''}`}>
                {quote?.surgeApplied ? `Hora pico ×${quote.surgeMultiplier}` : quote?.surgeEnabled ? 'Tarifa dinámica · fuera de pico' : 'Tarifa base'}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="hose-bay" role="radiogroup" aria-label="Conectores de la estación">
        {station.connectors.map((c) => {
          const point = latestByConnector.get(c.id);
          const chosen = connectorId === c.id;
          const enabled = selectable(c);
          return (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={chosen}
              className={`hose hose-${c.status.toLowerCase()}${chosen ? ' hose-chosen' : ''}${c.tier === 'ULTRA' ? ' hose-ultra' : ''}`}
              disabled={!enabled}
              onClick={() => setConnectorId(chosen ? null : c.id)}
              title={enabled ? `Elegir manguera ${c.id.toUpperCase()}` : CONNECTOR_LABEL[c.status]}
            >
              <span className="hose-head">
                {c.type === 'CCS2' ? <IconNozzleCCS /> : <IconNozzleChademo />}
                <span className="hose-id">{c.id.toUpperCase()}</span>
              </span>
              <span className="hose-power">
                <span className="hose-kw">{c.powerKw}</span> kW · {c.type}
              </span>
              {c.tier === 'ULTRA' && <span className="hose-tier">Ultra</span>}
              <span className={`mark mark-${c.status.toLowerCase()}`} aria-hidden="true" />
              <span className="hose-status">
                {CONNECTOR_LABEL[c.status]}
                {c.status === 'CHARGING' && point && ` · ${point.kwhDelivered.toFixed(1)} kWh`}
              </span>
            </button>
          );
        })}
      </div>

      <div className="keypad">
        <fieldset className="keypad-group fleet-cards">
          <legend>Tarjeta de flota</legend>
          {wallets.map((w) => (
            <label key={w.fleetId} className={`fleet-card${w.fleetId === fleetId ? ' fleet-card-on' : ''}`}>
              <input type="radio" name="fleet" value={w.fleetId} checked={w.fleetId === fleetId} onChange={() => setFleetId(w.fleetId)} />
              <span className="fleet-stripe" aria-hidden="true" />
              <span className="fleet-name">{w.fleetName}</span>
              <span className="fleet-balance">{usd(w.balanceCents)}</span>
            </label>
          ))}
        </fieldset>

        <fieldset className="keypad-group">
          <legend>Energía a entregar</legend>
          <div className="preset-keys">
            {PRESETS.map((p) => (
              <button key={p} type="button" className={`key${kwh === p ? ' key-on' : ''}`} aria-pressed={kwh === p} onClick={() => setKwh(p)}>
                {p}
                <small>kWh</small>
              </button>
            ))}
          </div>
          <label className={`boost-switch${boostEnabled ? '' : ' boost-locked'}`}>
            <input type="checkbox" checked={priority} disabled={!boostEnabled} onChange={(e) => {
              setPriority(e.target.checked);
              setConnectorId(null);
            }} />
            <span className="switch-track" aria-hidden="true">
              <span className="switch-thumb">{boostEnabled ? <IconKey size={14} /> : <IconLock size={14} />}</span>
            </span>
            <span>
              <strong>Ultra-carga prioritaria 350 kW</strong>
              <small>{boostEnabled ? 'Reserva un conector Ultra con bloqueo extendido' : 'Apagada en este ambiente (ENABLE_FAST_CHARGE_BOOST)'}</small>
            </span>
          </label>
        </fieldset>

        <div className="authorize">
          <button type="button" className="authorize-btn" disabled={!canAuthorize} onClick={() => void authorize()}>
            <IconBolt size={20} />
            {busy ? 'Autorizando…' : 'Autorizar y cargar'}
          </button>
          <div className="authorize-summary">
            <span>{wallet?.fleetName ?? 'Elige una flota'}</span>
            <span>
              {kwh} kWh · {connectorId ? `manguera ${connectorId.toUpperCase()}` : free > 0 ? 'mejor manguera libre' : 'sin mangueras libres'}
            </span>
          </div>
          {error && <p className="keypad-error" role="alert">{error}</p>}
          {free === 0 && !busy && <p className="keypad-hint">No hay conectores {priority ? 'Ultra' : 'estándar'} libres en esta estación.</p>}
        </div>
      </div>
    </section>
  );
}
