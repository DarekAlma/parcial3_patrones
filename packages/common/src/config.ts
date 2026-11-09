/**
 * Configuracion comun leida del entorno (ConfigMap de Kubernetes por ambiente).
 * Ningun valor de ambiente esta "quemado" en el codigo: la misma imagen corre
 * en dev, test y prod y solo cambian estas variables.
 */
export type Environment = 'dev' | 'test' | 'prod';
export type Track = 'stable' | 'canary';

export interface BaseConfig {
  service: string;
  environment: Environment;
  /** stable | canary: viaja en cada log para que CloudWatch separe las metricas del canary. */
  track: Track;
  version: string;
  port: number;
  project: string;
  awsRegion: string;
  /** Endpoint de Floci. undefined = AWS real. */
  awsEndpoint: string | undefined;
  /** Envia los logs a CloudWatch Logs ademas de stdout. */
  cloudWatchLogs: boolean;
}

export function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`Variable de entorno requerida: ${name}`);
  return value;
}

export function loadBaseConfig(service: string, defaultPort = 8080): BaseConfig {
  const environment = env('AEGIS_ENV', 'dev');
  if (!['dev', 'test', 'prod'].includes(environment)) {
    throw new Error(`AEGIS_ENV invalido: ${environment}`);
  }
  const track = env('TRACK', 'stable');
  return {
    service,
    environment: environment as Environment,
    track: track === 'canary' ? 'canary' : 'stable',
    version: env('APP_VERSION', 'local'),
    port: Number(env('PORT', String(defaultPort))),
    project: env('PROJECT', 'aegisvolt'),
    awsRegion: env('AWS_REGION', 'us-east-1'),
    awsEndpoint: process.env.AWS_ENDPOINT_URL || undefined,
    cloudWatchLogs: env('CLOUDWATCH_LOGS', 'false') === 'true',
  };
}

/** Nombre de tabla segun la convencion de Terraform: <project>-<recurso>-<ambiente>. */
export function tableName(config: Pick<BaseConfig, 'project' | 'environment'>, resource: string): string {
  const override = process.env[`TABLE_${resource.toUpperCase().replace(/-/g, '_')}`];
  return override || `${config.project}-${resource}-${config.environment}`;
}
