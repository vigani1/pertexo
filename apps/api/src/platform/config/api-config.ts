import { z } from 'zod';

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
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
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
  port: number;
}>;

export function parseApiConfig(
  environment: Record<string, string | undefined> = process.env,
): ApiConfig {
  const parsed = apiEnvironmentSchema.parse(environment);

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
    port: parsed.PORT,
  });
}
