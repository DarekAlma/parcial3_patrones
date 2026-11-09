import { hostname } from 'node:os';
import {
  CloudWatchLogsClient,
  CreateLogStreamCommand,
  PutLogEventsCommand,
  ResourceAlreadyExistsException,
} from '@aws-sdk/client-cloudwatch-logs';
import type { BaseConfig } from './config.js';

/**
 * Logger estructurado JSON.
 *
 * Cada linea incluye siempre: timestamp, level, service, environment, track,
 * version y (si existe) correlation_id = id de la SAGA. Asi en CloudWatch se
 * puede seguir UNA transaccion a traves de los 4 servicios:
 *
 *   fields @timestamp, service, event, message
 *   | filter correlation_id = "saga-..."
 *
 * Los metric filters de Terraform cuentan eventos por (Service, Track):
 *   event = "http_request"      -> RequestCount
 *   level = "ERROR"             -> ErrorCount
 *   event = "saga_compensated"  -> SagaCompensated
 *   event = "saga_failed"       -> SagaFailed
 */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type LogFields = Record<string, unknown> & { event?: string; correlation_id?: string };

interface Sink {
  write(line: string, timestamp: number): void;
  flush(): Promise<void>;
}

const stdoutSink: Sink = {
  write: (line) => process.stdout.write(`${line}\n`),
  flush: async () => {},
};

/** Envia lotes a CloudWatch Logs: log group /<project>/<env>/<service>, stream <pod>-<track>. */
class CloudWatchSink implements Sink {
  private buffer: { message: string; timestamp: number }[] = [];
  private timer: NodeJS.Timeout;
  private streamReady: Promise<void>;
  private readonly client: CloudWatchLogsClient;

  constructor(
    private readonly logGroupName: string,
    private readonly logStreamName: string,
    config: BaseConfig,
  ) {
    this.client = new CloudWatchLogsClient({ region: config.awsRegion, endpoint: config.awsEndpoint });
    this.streamReady = this.ensureStream();
    this.timer = setInterval(() => void this.flush(), 2000);
    this.timer.unref();
  }

  private async ensureStream(): Promise<void> {
    try {
      await this.client.send(new CreateLogStreamCommand({ logGroupName: this.logGroupName, logStreamName: this.logStreamName }));
    } catch (err) {
      if (!(err instanceof ResourceAlreadyExistsException)) throw err;
    }
  }

  write(message: string, timestamp: number): void {
    this.buffer.push({ message, timestamp });
    if (this.buffer.length >= 200) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length).sort((a, b) => a.timestamp - b.timestamp);
    try {
      await this.streamReady;
      await this.client.send(
        new PutLogEventsCommand({ logGroupName: this.logGroupName, logStreamName: this.logStreamName, logEvents: batch }),
      );
    } catch (err) {
      // Nunca tumbar el servicio por la observabilidad: queda en stdout.
      process.stderr.write(`cloudwatch sink error: ${(err as Error).message}\n`);
      this.streamReady = this.ensureStream();
    }
  }
}

export class Logger {
  constructor(
    private readonly base: Record<string, unknown>,
    private readonly sinks: Sink[],
  ) {}

  child(fields: LogFields): Logger {
    return new Logger({ ...this.base, ...fields }, this.sinks);
  }

  log(level: LogLevel, message: string, fields: LogFields = {}): void {
    const timestamp = Date.now();
    const entry: Record<string, unknown> = { timestamp: new Date(timestamp).toISOString(), level, ...this.base, ...fields, message };
    if (fields.error instanceof Error) {
      entry.error = { name: fields.error.name, message: fields.error.message };
    }
    const line = JSON.stringify(entry);
    for (const sink of this.sinks) sink.write(line, timestamp);
  }

  debug(message: string, fields?: LogFields): void {
    if (process.env.LOG_LEVEL === 'DEBUG') this.log('DEBUG', message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.log('INFO', message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.log('WARN', message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.log('ERROR', message, fields);
  }

  async flush(): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.flush()));
  }
}

export function createLogger(config: BaseConfig): Logger {
  const sinks: Sink[] = [];
  if (process.env.LOG_STDOUT !== 'false') sinks.push(stdoutSink);
  if (config.cloudWatchLogs) {
    const group = `/${config.project}/${config.environment}/${config.service}`;
    const stream = `${process.env.POD_NAME ?? hostname()}-${config.track}`;
    sinks.push(new CloudWatchSink(group, stream, config));
  }
  return new Logger(
    {
      service: config.service,
      environment: config.environment,
      track: config.track,
      version: config.version,
    },
    sinks,
  );
}

/** Logger silencioso para pruebas unitarias; guarda las entradas para poder verificarlas. */
export function createMemoryLogger(): { logger: Logger; entries: Record<string, unknown>[] } {
  const entries: Record<string, unknown>[] = [];
  const sink: Sink = { write: (line) => entries.push(JSON.parse(line)), flush: async () => {} };
  return { logger: new Logger({ service: 'test', environment: 'dev', track: 'stable' }, [sink]), entries };
}
