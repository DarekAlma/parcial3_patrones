import { useEffect, useState } from 'react';
import type { EnvName } from './types';

/**
 * Configuracion de despliegue servida por nginx (ConfigMap del ambiente):
 *   { "peers": { "dev": "http://...", "test": "...", "prod": "..." } }
 * Permite comparar en vivo las flags de los otros ambientes (solo lectura).
 */
export interface AppConfig {
  peers: Partial<Record<EnvName, string>>;
}

export function useAppConfig(): AppConfig {
  const [config, setConfig] = useState<AppConfig>({ peers: {} });
  useEffect(() => {
    fetch('/runtime/app-config.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { peers: {} }))
      .then((c: AppConfig) => setConfig({ peers: c.peers ?? {} }))
      .catch(() => setConfig({ peers: {} }));
  }, []);
  return config;
}
