import { z } from 'zod';
import { parseObservabilityConfig } from '@pertexo/observability/config';

const workerEnvironments = [
  'development',
  'test',
  'staging',
  'production',
] as const;

const workerLogLevels = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
] as const;

export const workerConfigSchema = z
  .object({
    DATABASE_WORKER_URL: z
      .url()
      .refine((value) => value.startsWith('postgresql://'), {
        message: 'DATABASE_WORKER_URL must be a postgresql:// URL',
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
    NODE_ENV: z.enum(workerEnvironments).default('development'),
    LOG_LEVEL: z.enum(workerLogLevels).default('info'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
    SERVICE_VERSION: z.string().trim().min(1).default('0.0.0-dev'),
    POSTGRES_OWNER_USER: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/u)
      .default('pertexo_owner'),
  })
  .transform(
    ({
      DATABASE_WORKER_URL,
      DATABASE_CONNECTION_TIMEOUT_MILLIS,
      DATABASE_IDLE_TIMEOUT_MILLIS,
      DATABASE_POOL_MAX,
      NODE_ENV,
      LOG_LEVEL,
      OTEL_EXPORTER_OTLP_ENDPOINT,
      SERVICE_VERSION,
      POSTGRES_OWNER_USER,
    }) => ({
      nodeEnv: NODE_ENV,
      logLevel: LOG_LEVEL,
      observability: parseObservabilityConfig({
        serviceName: 'pertexo-worker',
        serviceVersion: SERVICE_VERSION,
        environment: NODE_ENV,
        logLevel: LOG_LEVEL,
        ...(OTEL_EXPORTER_OTLP_ENDPOINT === undefined
          ? {}
          : { otlpHttpEndpoint: OTEL_EXPORTER_OTLP_ENDPOINT }),
      }),
      database: {
        connectionString: DATABASE_WORKER_URL,
        connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MILLIS,
        idleTimeoutMillis: DATABASE_IDLE_TIMEOUT_MILLIS,
        max: DATABASE_POOL_MAX,
        ownerRole: POSTGRES_OWNER_USER,
      },
    }),
  );

export type WorkerConfig = Readonly<z.output<typeof workerConfigSchema>>;

export function parseWorkerConfig(
  environment: Readonly<Record<string, unknown>> = process.env,
): WorkerConfig {
  const result = workerConfigSchema.safeParse(environment);

  if (!result.success) {
    throw new Error('Invalid worker configuration', { cause: result.error });
  }

  return Object.freeze({
    ...result.data,
    database: Object.freeze(result.data.database),
  });
}
