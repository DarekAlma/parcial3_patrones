/** Iconos dibujados a mano en la gramatica del surtidor: trazo 2px, puntas rectas. */
type P = { size?: number; title?: string };

const svg = (size: number, title: string | undefined, children: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="square" strokeLinejoin="miter" role={title ? 'img' : 'presentation'} aria-hidden={title ? undefined : true} aria-label={title}>
    {children}
  </svg>
);

export const IconLock = ({ size = 16, title }: P) =>
  svg(size, title, <>
    <rect x="5" y="11" width="14" height="9" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </>);

export const IconKey = ({ size = 16, title }: P) =>
  svg(size, title, <>
    <circle cx="8" cy="12" r="3.5" />
    <path d="M11.5 12H21M18 12v3M15 12v2" />
  </>);

export const IconBolt = ({ size = 16, title }: P) =>
  svg(size, title, <path d="M13 3 6 13h5l-1 8 7-10h-5z" />);

/** Conector CCS2: cuerpo superior con dos polos de CC abajo. */
export const IconPlugCCS = ({ size = 22, title }: P) =>
  svg(size, title, <>
    <path d="M6 3h12v7a6 6 0 0 1-12 0z" />
    <circle cx="9.5" cy="7.5" r="1" />
    <circle cx="14.5" cy="7.5" r="1" />
    <rect x="7" y="17" width="4" height="4" />
    <rect x="13" y="17" width="4" height="4" />
  </>);

export const IconPlugRound = ({ size = 22, title }: P) =>
  svg(size, title, <>
    <circle cx="12" cy="12" r="8" />
    <circle cx="9" cy="10" r="1.2" />
    <circle cx="15" cy="10" r="1.2" />
    <circle cx="12" cy="15" r="1.2" />
  </>);

/** Pistola CCS2 colgada en su soporte, con el cable saliendo hacia abajo. */
export const IconNozzleCCS = ({ size = 40, title }: P) => (
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="square" strokeLinejoin="miter" role={title ? 'img' : 'presentation'} aria-hidden={title ? undefined : true} aria-label={title}>
    <path d="M6 6h14v6H6z" />
    <path d="M9 12v4h8v-4" />
    <path d="M10 16l-2 12h12l-2-12" />
    <circle cx="12" cy="21" r="1.4" />
    <circle cx="16" cy="21" r="1.4" />
    <path d="M14 28v4c0 3 3 4 6 4h14" />
    <path d="M24 6h10v26" />
  </svg>
);

/** Pistola CHAdeMO (cabeza redonda) en su soporte. */
export const IconNozzleChademo = ({ size = 40, title }: P) => (
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="square" strokeLinejoin="miter" role={title ? 'img' : 'presentation'} aria-hidden={title ? undefined : true} aria-label={title}>
    <path d="M6 6h14v6H6z" />
    <path d="M9 12v4h8v-4" />
    <circle cx="13" cy="23" r="6" />
    <circle cx="13" cy="23" r="2" />
    <path d="M13 29v3c0 3 3 4 6 4h15" />
    <path d="M24 6h10v26" />
  </svg>
);

export const IconWarning = ({ size = 16, title }: P) =>
  svg(size, title, <>
    <path d="M12 3 2 21h20z" />
    <path d="M12 10v5M12 18v.5" />
  </>);
