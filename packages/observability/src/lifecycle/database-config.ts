import { z } from 'zod';

const timeoutMillis = z.coerce.number().int().positive();
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const POOL_SIZE = Object.freeze({ default: 5, max: 20 });

/** Shared process config must be safe to load before instrumented drivers. */
export const databaseClientEnvironmentSchema = z.object({
  DATABASE_URL: z.url().refine((value) => value.startsWith('postgresql://'), {
    message: 'DATABASE_URL must be a postgresql:// URL',
  }),
  DATABASE_CONNECTION_TIMEOUT_MILLIS: timeoutMillis.default(
    DEFAULT_CONNECTION_TIMEOUT_MS,
  ),
  DATABASE_IDLE_TIMEOUT_MILLIS: timeoutMillis.default(DEFAULT_IDLE_TIMEOUT_MS),
  DATABASE_POOL_MAX: z.coerce
    .number()
    .int()
    .positive()
    .max(POOL_SIZE.max)
    .default(POOL_SIZE.default),
  POSTGRES_OWNER_USER: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default('pertexo_owner'),
});

/** Project typed boundary values without validating the same input again. */
export function clientDatabaseConfig(
  environment: z.output<typeof databaseClientEnvironmentSchema>,
) {
  return Object.freeze({
    connectionString: environment.DATABASE_URL,
    connectionTimeoutMillis: environment.DATABASE_CONNECTION_TIMEOUT_MILLIS,
    idleTimeoutMillis: environment.DATABASE_IDLE_TIMEOUT_MILLIS,
    max: environment.DATABASE_POOL_MAX,
    ownerRole: environment.POSTGRES_OWNER_USER,
  });
}
