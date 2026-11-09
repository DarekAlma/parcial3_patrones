import { useEffect, useState } from 'react';
import FLAGS from '../graphql/FeatureFlags.graphql?raw';
import SET_FLAG from '../graphql/SetFeatureFlag.graphql?raw';
import { gql } from '../lib/graphql';
import { FLAG_COPY } from '../lib/format';
import type { EnvName, FeatureFlag } from '../lib/types';
import { IconKey, IconLock, IconWarning } from './Icons';

interface Props {
  environment: EnvName | null;
  adminEnabled: boolean;
  flags: FeatureFlag[];
  peers: Partial<Record<EnvName, string>>;
  onChanged: () => void;
}

const ENVS: EnvName[] = ['dev', 'test', 'prod'];

/**
 * Panel de servicio del surtidor: interruptores de llave para las feature
 * flags de ESTE ambiente (cambio en caliente, sin redesplegar) y una fila de
 * lamparas que muestra en vivo el estado de las mismas flags en los otros
 * ambientes: asi se ve que cambiar dev no toca prod.
 */
export function ServiceCabinet({ environment, adminEnabled, flags, peers, onChanged }: Props) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [peerFlags, setPeerFlags] = useState<Partial<Record<EnvName, FeatureFlag[] | 'offline'>>>({});

  useEffect(() => {
    const targets = ENVS.filter((e) => e !== environment && peers[e]);
    if (targets.length === 0) return;
    let alive = true;
    const load = () =>
      targets.forEach((e) =>
        gql<{ featureFlags: FeatureFlag[] }>(FLAGS, undefined, { baseUrl: peers[e] })
          .then((d) => alive && setPeerFlags((p) => ({ ...p, [e]: d.featureFlags })))
          .catch(() => alive && setPeerFlags((p) => ({ ...p, [e]: 'offline' }))),
      );
    load();
    const t = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [environment, peers]);

  async function toggle(f: FeatureFlag) {
    setPending(f.name);
    setError(null);
    try {
      await gql(SET_FLAG, { name: f.name, enabled: !f.enabled });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(null);
    }
  }

  const lamp = (env: EnvName, name: string) => {
    if (env === environment) {
      const f = flags.find((x) => x.name === name);
      return f ? (f.enabled ? 'on' : 'off') : 'unknown';
    }
    const list = peerFlags[env];
    if (!peers[env]) return 'unknown';
    if (!list) return 'loading';
    if (list === 'offline') return 'offline';
    const f = list.find((x) => x.name === name);
    return f ? (f.enabled ? 'on' : 'off') : 'unknown';
  };

  const LAMP_TEXT: Record<string, string> = { on: 'ON', off: 'off', unknown: 'sin endpoint', loading: '…', offline: 'sin señal' };

  return (
    <section className="cabinet" aria-labelledby="cabinet-title">
      <div className="cabinet-door">
        <div className="cabinet-head">
          <h3 id="cabinet-title">Panel de servicio · feature flags</h3>
          <p>
            {adminEnabled ? (
              <>
                <IconKey size={14} /> Llave de mantenimiento puesta: los cambios aplican en ≤3 s, sin redesplegar.
              </>
            ) : (
              <>
                <IconLock size={14} /> Panel bloqueado en {environment === 'prod' ? 'producción' : 'este ambiente'}: solo lectura.
              </>
            )}
          </p>
        </div>

        <div className="switch-bank">
          {flags.map((f) => {
            const copy = FLAG_COPY[f.name] ?? { title: f.name, on: '', off: '' };
            const danger = f.name === 'SIMULATE_CHARGER_HARDWARE_FAULT';
            return (
              <div key={f.name} className={`service-switch${f.enabled ? ' is-on' : ''}${danger ? ' is-danger' : ''}`}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={f.enabled}
                  aria-label={copy.title}
                  className="key-switch"
                  disabled={!adminEnabled || pending === f.name}
                  onClick={() => void toggle(f)}
                >
                  <span className="key-dial" aria-hidden="true">
                    <span className="key-blade" />
                  </span>
                  <span className="key-legend" aria-hidden="true">
                    <span>off</span>
                    <span>on</span>
                  </span>
                </button>
                <div className="service-text">
                  <strong>
                    {danger && <IconWarning size={15} />} {copy.title}
                  </strong>
                  <code>{f.name}</code>
                  <span>{f.enabled ? copy.on : copy.off}</span>
                  {f.updatedBy && f.updatedAt && (
                    <small>
                      Último cambio: {f.updatedBy} · {new Date(f.updatedAt).toLocaleTimeString('es-CO', { hour12: false })}
                    </small>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {error && <p className="keypad-error" role="alert">{error}</p>}
      </div>

      <table className="lamp-board">
        <caption>Mismas flags en cada ambiente (independientes)</caption>
        <thead>
          <tr>
            <th scope="col">Flag</th>
            {ENVS.map((e) => (
              <th key={e} scope="col" className={e === environment ? 'is-current' : ''}>
                {e.toUpperCase()}
                {e === environment && <small> · aquí</small>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {flags.map((f) => (
            <tr key={f.name}>
              <th scope="row">{FLAG_COPY[f.name]?.title ?? f.name}</th>
              {ENVS.map((e) => {
                const state = lamp(e, f.name);
                return (
                  <td key={e} className={e === environment ? 'is-current' : ''}>
                    <span className={`lamp lamp-${state}`}>
                      <span className="lamp-bulb" aria-hidden="true" />
                      {LAMP_TEXT[state]}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
