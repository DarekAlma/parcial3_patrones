import type { EnvironmentInfo } from '../lib/types';
import { IconLock } from './Icons';

/**
 * Marquesina de la estacion + placa de AMBIENTE colgada. El ambiente nunca es
 * un detalle: cada uno tiene su propia placa (color, texto y patron).
 */
const ENV_SIGN = {
  dev: { name: 'DESARROLLO', code: 'DEV', note: 'Datos de prueba · cambios libres' },
  test: { name: 'PRUEBAS', code: 'TEST', note: 'Validación previa a producción' },
  prod: { name: 'PRODUCCIÓN', code: 'PROD', note: 'Flotas reales · flags bloqueadas' },
} as const;

interface Props {
  env: EnvironmentInfo | null;
  live: boolean;
  lastOk: number | null;
}

export function Canopy({ env, live, lastOk }: Props) {
  const sign = env ? ENV_SIGN[env.environment] : null;
  return (
    <header className="canopy">
      <div className="canopy-brand">
        <span className="wordmark">
          Aegis<span>Volt</span>
        </span>
        <span className="canopy-sub">Patio de carga · flotas eléctricas</span>
      </div>

      <div className={`env-sign env-${env?.environment ?? 'none'}`} role="status" aria-live="polite">
        <span className="env-hangers" aria-hidden="true" />
        <span className="env-code">{sign?.code ?? '···'}</span>
        <span className="env-name">
          {sign ? sign.name : 'Conectando…'}
          {env?.environment === 'prod' && <IconLock size={18} title="Producción protegida" />}
        </span>
        <span className="env-note">{sign?.note ?? 'Buscando el ambiente del API Gateway'}</span>
      </div>

      <dl className="canopy-meta">
        <div>
          <dt>Versión</dt>
          <dd>{env?.version ?? '—'}</dd>
        </div>
        <div>
          <dt>Pista</dt>
          <dd>{env?.track ?? '—'}</dd>
        </div>
        <div>
          <dt>Señal</dt>
          <dd className={live ? 'signal-on' : 'signal-off'}>
            <span className="signal-lamp" aria-hidden="true" />
            {live ? 'En vivo' : 'Sin conexión'}
            {lastOk && <time dateTime={new Date(lastOk).toISOString()}> · {new Date(lastOk).toLocaleTimeString('es-CO', { hour12: false })}</time>}
          </dd>
        </div>
      </dl>
    </header>
  );
}
