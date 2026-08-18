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
    NODE_ENV: z.enum(workerEnvironments).default('development'),
    LOG_LEVEL: z.enum(workerLogLevels).default('info'),
  })
  .transform(({ NODE_ENV, LOG_LEVEL }) => ({
    nodeEnv: NODE_ENV,
    logLevel: LOG_LEVEL,
  }));

export type WorkerConfig = Readonly<z.output<typeof workerConfigSchema>>;

export function parseWorkerConfig(
  environment: Readonly<Record<string, unknown>> = process.env,
): WorkerConfig {
  const result = workerConfigSchema.safeParse(environment);

  if (!result.success) {
    throw new Error('Invalid worker configuration', { cause: result.error });
  }

  return Object.freeze(result.data);
}
