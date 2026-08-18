import { z } from 'zod';

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
  })
  .transform(
    ({
      DATABASE_WORKER_URL,
      DATABASE_CONNECTION_TIMEOUT_MILLIS,
      DATABASE_IDLE_TIMEOUT_MILLIS,
      DATABASE_POOL_MAX,
      NODE_ENV,
      LOG_LEVEL,
    }) => ({
      nodeEnv: NODE_ENV,
      logLevel: LOG_LEVEL,
      database: {
        connectionString: DATABASE_WORKER_URL,
        connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MILLIS,
        idleTimeoutMillis: DATABASE_IDLE_TIMEOUT_MILLIS,
        max: DATABASE_POOL_MAX,
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
