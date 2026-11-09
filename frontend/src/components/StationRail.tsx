import type { Station } from '../lib/types';
import { Lcd } from './Lcd';

interface Props {
  stations: Station[];
  selected: string | null;
  onSelect: (id: string) => void;
}

/** Fila de surtidores del patio: cada uno muestra en su display cuantas mangueras estan libres. */
export function StationRail({ stations, selected, onSelect }: Props) {
  return (
    <nav className="rail" aria-label="Electrolineras">
      {stations.map((s) => {
        const charging = s.connectors.filter((c) => c.status === 'CHARGING').length;
        const held = s.connectors.filter((c) => c.status === 'RESERVED').length;
        return (
          <button key={s.id} type="button" className={`rail-pump${selected === s.id ? ' rail-pump-on' : ''}`} onClick={() => onSelect(s.id)} aria-current={selected === s.id ? 'true' : undefined}>
            <span className="rail-name">{s.name.replace(/^(Electrolinera|Hub Log[ií]stico|Centro de Carga) /, '')}</span>
            <span className="rail-city">{s.city}</span>
            <Lcd size="sm" value={`${s.availableConnectors}`} label="libres" unit={`/${s.totalConnectors}`} dim={selected !== s.id} />
            <span className="rail-hoses" aria-label={`${charging} cargando, ${held} reservados`}>
              {s.connectors.map((c) => (
                <span key={c.id} className={`mark mark-${c.status.toLowerCase()}`} />
              ))}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
