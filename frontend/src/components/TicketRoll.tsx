import { clock, dateShort, SAGA_LABEL, shortId, usd } from '../lib/format';
import type { ChargeTransaction } from '../lib/types';

interface Props {
  items: ChargeTransaction[];
  selected: string | null;
  onSelect: (sagaId: string) => void;
}

/** Rollo de comprobantes: historial de SAGAs con su estado de compensacion. */
export function TicketRoll({ items, selected, onSelect }: Props) {
  return (
    <section className="roll" aria-labelledby="roll-title">
      <div className="roll-head">
        <h3 id="roll-title">Rollo de comprobantes</h3>
        <span>{items.length} transacciones</span>
      </div>
      {items.length === 0 ? (
        <p className="roll-empty">Todavía no hay cargas en este ambiente. La primera autorización abrirá el rollo.</p>
      ) : (
        <ul className="roll-list">
          {items.map((t) => {
            const reversed = t.status === 'COMPENSATED' || t.status === 'FAILED';
            return (
              <li key={t.sagaId}>
                <button type="button" className={`roll-item${reversed ? ' roll-reversed' : ''}${selected === t.sagaId ? ' roll-selected' : ''}`} onClick={() => onSelect(t.sagaId)} aria-pressed={selected === t.sagaId}>
                  <span className={`smark smark-${t.status.toLowerCase()}`} aria-hidden="true" />
                  <span className="roll-when">
                    {dateShort(t.createdAt)} <b>{clock(t.createdAt)}</b>
                  </span>
                  <span className="roll-what">
                    {t.stationId.replace('st-', '').toUpperCase()} · {t.fleetId.replace('fleet-', '')} · {t.kwh} kWh
                  </span>
                  <span className="roll-status">{SAGA_LABEL[t.status]}</span>
                  <span className="roll-amount">{reversed ? 'reverso' : usd(t.amountCents)}</span>
                  <span className="roll-id">{shortId(t.sagaId)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
