/**
 * Levanta los 4 microservicios como PROCESOS independientes (igual que en
 * Kubernetes: un proceso por servicio, configurados solo por variables de
 * entorno y comunicados por HTTP). Lo usan las pruebas E2E y `npm run dev:stack`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { FLOCI_ENDPOINT, type TestTables } from './floci.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export interface ProcessStack {
  gatewayUrl: string;
  urls: Record<string, string>;
  logs: Record<string, string[]>;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitHealthy(url: string, proc: ChildProcess, logs: string[], timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`El proceso termino (${proc.exitCode}):\n${logs.slice(-20).join('')}`);
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      /* aun no escucha */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} no respondio /health:\n${logs.slice(-20).join('')}`);
}

export interface StackOptions {
  environment?: 'dev' | 'test' | 'prod';
  /** Tablas efimeras (E2E). Sin tablas se usan las del ambiente: aegisvolt-<x>-<env>. */
  tables?: TestTables;
  extraEnv?: Record<string, string>;
  ports?: Partial<Record<'gateway' | 'station' | 'billing' | 'dispatch', number>>;
}

export async function startProcessStack(opts: StackOptions = {}): Promise<ProcessStack> {
  const ports = {
    gateway: opts.ports?.gateway ?? (await freePort()),
    station: opts.ports?.station ?? (await freePort()),
    billing: opts.ports?.billing ?? (await freePort()),
    dispatch: opts.ports?.dispatch ?? (await freePort()),
  };
  const urls = {
    gateway: `http://127.0.0.1:${ports.gateway}`,
    station: `http://127.0.0.1:${ports.station}`,
    billing: `http://127.0.0.1:${ports.billing}`,
    dispatch: `http://127.0.0.1:${ports.dispatch}`,
  };
  const tableEnv: Record<string, string> = opts.tables
    ? {
        TABLE_RESERVATIONS: opts.tables.reservations,
        TABLE_BILLING: opts.tables.billing,
        TABLE_DISPATCH: opts.tables.dispatch,
        TABLE_SAGA: opts.tables.saga,
        TABLE_FEATURE_FLAGS: opts.tables.flags,
      }
    : {};
  const common: Record<string, string> = {
    AEGIS_ENV: opts.environment ?? 'dev',
    AWS_ENDPOINT_URL: FLOCI_ENDPOINT,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    APP_VERSION: 'e2e',
    STATION_SERVICE_URL: urls.station,
    BILLING_SERVICE_URL: urls.billing,
    DISPATCH_SERVICE_URL: urls.dispatch,
    FLAG_ADMIN_ENABLED: 'true',
    SEED_DATA: 'true',
    ...tableEnv,
    ...opts.extraEnv,
  };

  const defs = [
    { name: 'station-reservation-service', entry: 'services/station-reservation-service/src/index.ts', port: ports.station, url: urls.station },
    { name: 'billing-wallet-service', entry: 'services/billing-wallet-service/src/index.ts', port: ports.billing, url: urls.billing },
    { name: 'energy-dispatch-service', entry: 'services/energy-dispatch-service/src/index.ts', port: ports.dispatch, url: urls.dispatch },
    { name: 'graphql-gateway', entry: 'graphql-gateway/src/index.ts', port: ports.gateway, url: urls.gateway },
  ];

  const procs: ChildProcess[] = [];
  const logs: Record<string, string[]> = {};
  for (const d of defs) {
    logs[d.name] = [];
    // tsx ejecuta el TypeScript directamente y resuelve @aegisvolt/common por tsconfig paths.
    const proc = spawn(process.execPath, ['--import', 'tsx', d.entry], {
      cwd: ROOT,
      env: { ...process.env, ...common, PORT: String(d.port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout!.on('data', (b: Buffer) => logs[d.name]!.push(b.toString()));
    proc.stderr!.on('data', (b: Buffer) => logs[d.name]!.push(b.toString()));
    procs.push(proc);
  }
  try {
    await Promise.all(defs.map((d, i) => waitHealthy(d.url, procs[i]!, logs[d.name]!)));
  } catch (err) {
    procs.forEach((p) => p.kill());
    throw err;
  }

  return {
    gatewayUrl: urls.gateway,
    urls,
    logs,
    stop: async () => {
      await Promise.all(
        procs.map(
          (p) =>
            new Promise<void>((resolve) => {
              if (p.exitCode !== null) return resolve();
              p.once('exit', () => resolve());
              p.kill();
            }),
        ),
      );
    },
  };
}
