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
    DATABASE_DISPATCHER_URL: z
      .url()
      .refine((value) => value.startsWith('postgresql://'), {
        message: 'DATABASE_DISPATCHER_URL must be a postgresql:// URL',
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
    DATABASE_DISPATCHER_POOL_MAX: z.coerce
      .number()
      .int()
      .positive()
      .max(10)
      .default(2),
    REDIS_URL: z
      .url()
      .refine(
        (value) =>
          value.startsWith('redis://') || value.startsWith('rediss://'),
        {
          message: 'REDIS_URL must be a redis:// or rediss:// URL',
        },
      ),
    OUTBOX_DISPATCH_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25),
    OUTBOX_DISPATCH_LEASE_MILLIS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
    OUTBOX_DISPATCH_MAX_ATTEMPTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(10),
    OUTBOX_DISPATCH_OPERATION_TIMEOUT_MILLIS: z.coerce
      .number()
      .int()
      .min(100)
      .max(120_000)
      .default(5_000),
    OUTBOX_DISPATCH_POLL_MILLIS: z.coerce
      .number()
      .int()
      .min(10)
      .max(60_000)
      .default(250),
    OUTBOX_DISPATCH_RETRY_MILLIS: z.coerce
      .number()
      .int()
      .min(1)
      .max(300_000)
      .default(1_000),
    WORKER_INSTANCE_ID: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,96}$/u)
      .default('worker-local'),
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
      DATABASE_DISPATCHER_URL,
      DATABASE_CONNECTION_TIMEOUT_MILLIS,
      DATABASE_IDLE_TIMEOUT_MILLIS,
      DATABASE_POOL_MAX,
      DATABASE_DISPATCHER_POOL_MAX,
      REDIS_URL,
      OUTBOX_DISPATCH_BATCH_SIZE,
      OUTBOX_DISPATCH_LEASE_MILLIS,
      OUTBOX_DISPATCH_MAX_ATTEMPTS,
      OUTBOX_DISPATCH_OPERATION_TIMEOUT_MILLIS,
      OUTBOX_DISPATCH_POLL_MILLIS,
      OUTBOX_DISPATCH_RETRY_MILLIS,
      WORKER_INSTANCE_ID,
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
      dispatcherDatabase: {
        connectionString: DATABASE_DISPATCHER_URL,
        connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MILLIS,
        idleTimeoutMillis: DATABASE_IDLE_TIMEOUT_MILLIS,
        max: DATABASE_DISPATCHER_POOL_MAX,
        ownerRole: POSTGRES_OWNER_USER,
      },
      outboxDispatcher: {
        batchSize: OUTBOX_DISPATCH_BATCH_SIZE,
        leaseDurationMillis: OUTBOX_DISPATCH_LEASE_MILLIS,
        leaseOwner: `outbox:${WORKER_INSTANCE_ID}`,
        maxAttempts: OUTBOX_DISPATCH_MAX_ATTEMPTS,
        operationTimeoutMillis: OUTBOX_DISPATCH_OPERATION_TIMEOUT_MILLIS,
        pollIntervalMillis: OUTBOX_DISPATCH_POLL_MILLIS,
        retryDelayMillis: OUTBOX_DISPATCH_RETRY_MILLIS,
      },
      redisUrl: REDIS_URL,
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
    dispatcherDatabase: Object.freeze(result.data.dispatcherDatabase),
    outboxDispatcher: Object.freeze(result.data.outboxDispatcher),
  });
}
