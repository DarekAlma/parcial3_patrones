/**
 * Display de 7 segmentos: debajo de cada valor se dibujan los segmentos
 * apagados ("8" fantasma), como en el vidrio de un surtidor real.
 */
interface Props {
  value: string;
  size?: 'xl' | 'lg' | 'md' | 'sm';
  label?: string;
  unit?: string;
  dim?: boolean;
}

export function Lcd({ value, size = 'md', label, unit, dim }: Props) {
  // En DSEG7 "!" es un hueco del ancho de un digito: se usa para alinear.
  const ghost = value.replace(/[0-9!-]/g, '8');
  return (
    <div className={`lcd lcd-${size}${dim ? ' lcd-dim' : ''}`}>
      {label && <span className="lcd-label">{label}</span>}
      <span className="lcd-digits" aria-label={`${value.replace(/!/g, '').trim()}${unit ? ` ${unit}` : ''}`}>
        <span className="lcd-ghost" aria-hidden="true">{ghost}</span>
        <span className="lcd-value" aria-hidden="true">{value}</span>
      </span>
      {unit && <span className="lcd-unit">{unit}</span>}
    </div>
  );
}

/** Formatea con ancho fijo para que los digitos no "bailen" al cambiar. */
export const pad = (n: number, int: number, dec: number) => {
  const s = Math.max(0, n).toFixed(dec);
  const [i, d] = s.split('.');
  const padded = (i ?? '0').padStart(int, '!');
  return dec ? `${padded}.${d}` : padded;
};
