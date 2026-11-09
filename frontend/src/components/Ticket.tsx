import { useMemo } from 'react';
import { clock, COMPENSATION_LABEL, dateShort, duration, ERROR_LABEL, ms, OUTCOME_LABEL, SAGA_LABEL, shortId, STEP_LABEL, usd } from '../lib/format';
import type { ChargeTransaction, SagaStep } from '../lib/types';

/** Codigo de barras deterministico a partir del correlation_id (solo decorativo-funcional: identifica el ticket). */
function Barcode({ value }: { value: string }) {
  const bars = useMemo(() => {
    let h = 2166136261;
    const out: number[] = [];
    for (let i = 0; i < 46; i++) {
      h ^= value.charCodeAt(i % value.length) + i;
      h = Math.imul(h, 16777619);
      out.push(1 + (Math.abs(h) % 3));
    }
    return out;
  }, [value]);
  return (
    <div className="barcode" aria-hidden="true">
      {bars.map((w, i) => (
        <span key={i} style={{ width: w, opacity: i % 2 ? 0 : 1 }} />
      ))}
    </div>
  );
}

function stepMark(s: SagaStep) {
  return <span className={`tmark tmark-${s.status.toLowerCase()}`} aria-hidden="true" />;
}

const STEP_STATUS_TEXT: Record<string, string> = {
  PENDING: 'no ejecutado',
  RUNNING: 'en curso',
  SUCCEEDED: 'ok',
  FAILED: 'falló',
  COMPENSATING: 'revirtiendo',
  COMPENSATED: 'revertido',
  COMPENSATION_FAILED: 'reversión fallida',
};

interface Props {
  tx: ChargeTransaction | null;
  printing: boolean;
}

/**
 * El ticket termico de la SAGA. Cada paso es un renglon con su marca impresa
 * y su tiempo a la derecha; un paso revertido sale tachado. Si la SAGA se
 * revirtio, el ticket se imprime en negativo con el COMPROBANTE DE REVERSO.
 */
export function Ticket({ tx, printing }: Props) {
  if (!tx) {
    return (
      <article className="ticket ticket-blank" aria-label="Sin transacciones">
        <p className="ticket-title">Aegis<b>Volt</b></p>
        <p className="ticket-wait">Esperando autorización</p>
        <p className="ticket-faint">El comprobante de la próxima carga se imprimirá aquí, paso por paso.</p>
      </article>
    );
  }

  const reversed = tx.status === 'COMPENSATED' || tx.status === 'FAILED' || tx.status === 'COMPENSATING';
  const failure = tx.error ? ERROR_LABEL[tx.error.code] ?? tx.error.message : null;
  return (
    <article key={tx.sagaId} className={`ticket${reversed ? ' ticket-negative' : ''}${printing ? ' ticket-printing' : ''}`} aria-label={`Comprobante ${shortId(tx.sagaId)}: ${SAGA_LABEL[tx.status]}`}>
      <header className="ticket-head">
        <p className="ticket-title">Aegis<b>Volt</b></p>
        <p className="ticket-faint">Comprobante de carga · {tx.environment.toUpperCase()}</p>
        <p className="ticket-faint">
          {dateShort(tx.createdAt)} {clock(tx.createdAt)} · N.º {shortId(tx.sagaId)}
        </p>
      </header>

      <dl className="ticket-lines">
        <div><dt>Estación</dt><dd>{tx.stationId.replace('st-', '').toUpperCase()}</dd></div>
        <div><dt>Manguera</dt><dd>{tx.connectorId?.toUpperCase() ?? '—'}{tx.priority ? ' · ULTRA' : ''}</dd></div>
        <div><dt>Flota</dt><dd>{tx.fleetId}</dd></div>
        <div><dt>Energía</dt><dd>{tx.kwh.toFixed(1)} kWh</dd></div>
        <div><dt>Tarifa</dt><dd>{tx.quote ? `${usd(tx.quote.priceCentsPerKwh)}/kWh${tx.quote.surgeApplied ? ' ×1.5' : ''}` : '—'}</dd></div>
      </dl>

      <p className="ticket-rule">Transacción distribuida</p>
      <ol className="ticket-steps">
        {tx.steps.map((s) => (
          <li key={s.name} className={`tstep tstep-${s.status.toLowerCase()}`}>
            {stepMark(s)}
            <span className="tstep-name">{STEP_LABEL[s.name] ?? s.name}</span>
            <span className="tstep-time">{s.status === 'PENDING' ? '—' : ms(s.startedAt, s.finishedAt) || STEP_STATUS_TEXT[s.status]}</span>
            <span className="tstep-state">
              {STEP_STATUS_TEXT[s.status]}
              {s.attempts > 1 ? ` · ${s.attempts} intentos` : ''}
            </span>
          </li>
        ))}
      </ol>

      {reversed && (
        <section className="reverso" aria-label="Comprobante de reverso">
          <p className="reverso-stamp">Reverso</p>
          {failure && <p className="reverso-cause">{failure}</p>}
          <ol className="ticket-steps">
            {tx.compensations.length === 0 && <li className="tstep"><span className="tstep-name">Nada que revertir: ningún paso alcanzó a completarse</span></li>}
            {tx.compensations.map((c, i) => (
              <li key={`${c.step}-${i}`} className={`tstep tstep-${c.status === 'SUCCEEDED' ? 'compensated' : 'failed'}`}>
                <span className={`tmark tmark-${c.status === 'SUCCEEDED' ? 'compensated' : 'failed'}`} aria-hidden="true" />
                <span className="tstep-name">{COMPENSATION_LABEL[c.step] ?? c.step}</span>
                <span className="tstep-time">{clock(c.at)}</span>
                <span className="tstep-state">
                  {c.outcome ? OUTCOME_LABEL[c.outcome] ?? c.outcome : c.status.toLowerCase()}
                  {c.attempts > 1 ? ` · ${c.attempts} intentos` : ''}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <footer className="ticket-foot">
        <div className="ticket-total">
          <span>{reversed ? 'Saldo retenido' : 'Total'}</span>
          <span>{reversed ? usd(0) : usd(tx.amountCents)}</span>
        </div>
        <p className="ticket-status">
          {SAGA_LABEL[tx.status]}
          {tx.durationMs != null && ` en ${duration(tx.durationMs)}`}
        </p>
        <Barcode value={tx.correlationId} />
        <p className="ticket-faint ticket-cid">correlation_id {tx.correlationId}</p>
      </footer>
    </article>
  );
}
