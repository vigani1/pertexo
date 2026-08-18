import { z } from 'zod';
import { parseObservabilityConfig } from '@pertexo/observability/config';
import type { ObservabilityConfig } from '@pertexo/observability/config';

const API_NODE_ENVIRONMENTS = [
  'development',
  'test',
  'staging',
  'production',
] as const;

const apiEnvironmentSchema = z.object({
  DATABASE_API_URL: z
    .url()
    .refine((value) => value.startsWith('postgresql://'), {
      message: 'DATABASE_API_URL must be a postgresql:// URL',
    }),
  DATABASE_CONNECTION_TIMEOUT_MILLIS: z.coerce
    .number()
    .int()
    .positive()
    .default(5_000),
  DATABASE_IDLE_TIMEOUT_MILLIS: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(20).default(5),
  HOST: z.string().trim().min(1).default('0.0.0.0'),
  NODE_ENV: z.enum(API_NODE_ENVIRONMENTS).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  SERVICE_VERSION: z.string().trim().min(1).default('0.0.0-dev'),
  POSTGRES_OWNER_USER: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default('pertexo_owner'),
});

export type ApiNodeEnvironment = (typeof API_NODE_ENVIRONMENTS)[number];

export type ApiConfig = Readonly<{
  database: Readonly<{
    connectionString: string;
    connectionTimeoutMillis: number;
    idleTimeoutMillis: number;
    max: number;
    ownerRole: string;
  }>;
  host: string;
  nodeEnv: ApiNodeEnvironment;
  observability: ObservabilityConfig;
  port: number;
}>;

export function parseApiConfig(
  environment: Record<string, string | undefined> = process.env,
): ApiConfig {
  const parsed = apiEnvironmentSchema.parse(environment);
  const observability = parseObservabilityConfig({
    serviceName: 'pertexo-api',
    serviceVersion: parsed.SERVICE_VERSION,
    environment: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    ...(parsed.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
      ? {}
      : { otlpHttpEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT }),
  });

  return Object.freeze({
    database: Object.freeze({
      connectionString: parsed.DATABASE_API_URL,
      connectionTimeoutMillis: parsed.DATABASE_CONNECTION_TIMEOUT_MILLIS,
      idleTimeoutMillis: parsed.DATABASE_IDLE_TIMEOUT_MILLIS,
      max: parsed.DATABASE_POOL_MAX,
      ownerRole: parsed.POSTGRES_OWNER_USER,
    }),
    host: parsed.HOST,
    nodeEnv: parsed.NODE_ENV,
    observability,
    port: parsed.PORT,
  });
}
