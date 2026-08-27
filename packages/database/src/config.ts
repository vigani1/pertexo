import { z } from 'zod';

const databaseConfigSchema = z.object({
  connectionString: z
    .url()
    .refine((value) => value.startsWith('postgresql://'), {
      message: 'must be a postgresql:// URL',
    }),
  connectionTimeoutMillis: z.number().int().positive().default(5_000),
  idleTimeoutMillis: z.number().int().positive().default(30_000),
  max: z.number().int().positive().max(100).default(10),
  ownerRole: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default('pertexo_owner'),
  workerRuntimeRole: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default('pertexo_worker'),
});

export type DatabaseConfig = Readonly<z.output<typeof databaseConfigSchema>>;

export function parseDatabaseConfig(
  input: z.input<typeof databaseConfigSchema>,
): DatabaseConfig {
  return Object.freeze(databaseConfigSchema.parse(input));
}

const migrationEnvironmentSchema = z.object({
  DATABASE_MIGRATION_URL: z
    .url()
    .refine((value) => value.startsWith('postgresql://'), {
      message: 'DATABASE_MIGRATION_URL must be a postgresql:// URL',
    }),
  POSTGRES_OWNER_USER: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default('pertexo_owner'),
  POSTGRES_API_RUNTIME_USER: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default('pertexo_api'),
  POSTGRES_DISPATCHER_RUNTIME_USER: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default('pertexo_dispatcher'),
  POSTGRES_MAINTENANCE_USER: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default('pertexo_maintenance'),
  POSTGRES_LIFECYCLE_COMMAND_USER: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default('pertexo_lifecycle_command'),
  POSTGRES_OPERATOR_USER: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default('pertexo_operator'),
  POSTGRES_WORKER_RUNTIME_USER: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default('pertexo_worker'),
});

export type MigrationConfig = Readonly<{
  apiRuntimeRole: string;
  connectionString: string;
  dispatcherRole: string;
  maintenanceRole: string;
  lifecycleCommandRole: string;
  operatorRole: string;
  ownerRole: string;
  workerRuntimeRole: string;
}>;

export function parseMigrationConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): MigrationConfig {
  const parsed = migrationEnvironmentSchema.parse(environment);
  return Object.freeze({
    apiRuntimeRole: parsed.POSTGRES_API_RUNTIME_USER,
    connectionString: parsed.DATABASE_MIGRATION_URL,
    dispatcherRole: parsed.POSTGRES_DISPATCHER_RUNTIME_USER,
    maintenanceRole: parsed.POSTGRES_MAINTENANCE_USER,
    lifecycleCommandRole: parsed.POSTGRES_LIFECYCLE_COMMAND_USER,
    operatorRole: parsed.POSTGRES_OPERATOR_USER,
    ownerRole: parsed.POSTGRES_OWNER_USER,
    workerRuntimeRole: parsed.POSTGRES_WORKER_RUNTIME_USER,
  });
}

const dispatcherEnvironmentSchema = z.object({
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
  DATABASE_DISPATCHER_POOL_MAX: z.coerce
    .number()
    .int()
    .positive()
    .max(10)
    .default(2),
  POSTGRES_OWNER_USER: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default('pertexo_owner'),
  POSTGRES_WORKER_RUNTIME_USER: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default('pertexo_worker'),
});

const maintenanceEnvironmentSchema = z.object({
  DATABASE_MAINTENANCE_URL: z
    .url()
    .refine((value) => value.startsWith('postgresql://'), {
      message: 'DATABASE_MAINTENANCE_URL must be a postgresql:// URL',
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
  DATABASE_MAINTENANCE_POOL_MAX: z.coerce
    .number()
    .int()
    .positive()
    .max(10)
    .default(2),
  POSTGRES_OWNER_USER: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default('pertexo_owner'),
  POSTGRES_WORKER_RUNTIME_USER: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default('pertexo_worker'),
});

const lifecycleCommandEnvironmentSchema = z.object({
  DATABASE_LIFECYCLE_COMMAND_URL: z
    .url()
    .refine((value) => value.startsWith('postgresql://'), {
      message: 'DATABASE_LIFECYCLE_COMMAND_URL must be a postgresql:// URL',
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
  DATABASE_LIFECYCLE_COMMAND_POOL_MAX: z.coerce
    .number()
    .int()
    .positive()
    .max(10)
    .default(2),
  POSTGRES_OWNER_USER: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default('pertexo_owner'),
  POSTGRES_WORKER_RUNTIME_USER: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default('pertexo_worker'),
});

const operatorEnvironmentSchema = z.object({
  DATABASE_OPERATOR_URL: z
    .url()
    .refine((value) => value.startsWith('postgresql://'), {
      message: 'DATABASE_OPERATOR_URL must be a postgresql:// URL',
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
  POSTGRES_OPERATOR_USER: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default('pertexo_operator'),
  POSTGRES_OWNER_USER: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default('pertexo_owner'),
});

export function parseLifecycleCommandDatabaseConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseConfig {
  const parsed = lifecycleCommandEnvironmentSchema.parse(environment);
  return parseDatabaseConfig({
    connectionString: parsed.DATABASE_LIFECYCLE_COMMAND_URL,
    connectionTimeoutMillis: parsed.DATABASE_CONNECTION_TIMEOUT_MILLIS,
    idleTimeoutMillis: parsed.DATABASE_IDLE_TIMEOUT_MILLIS,
    max: parsed.DATABASE_LIFECYCLE_COMMAND_POOL_MAX,
    ownerRole: parsed.POSTGRES_OWNER_USER,
    workerRuntimeRole: parsed.POSTGRES_WORKER_RUNTIME_USER,
  });
}

export function parseMaintenanceDatabaseConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseConfig {
  const parsed = maintenanceEnvironmentSchema.parse(environment);
  return parseDatabaseConfig({
    connectionString: parsed.DATABASE_MAINTENANCE_URL,
    connectionTimeoutMillis: parsed.DATABASE_CONNECTION_TIMEOUT_MILLIS,
    idleTimeoutMillis: parsed.DATABASE_IDLE_TIMEOUT_MILLIS,
    max: parsed.DATABASE_MAINTENANCE_POOL_MAX,
    ownerRole: parsed.POSTGRES_OWNER_USER,
    workerRuntimeRole: parsed.POSTGRES_WORKER_RUNTIME_USER,
  });
}

export function parseOperatorDatabaseConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseConfig & Readonly<{ operatorRole: string }> {
  const parsed = operatorEnvironmentSchema.parse(environment);
  return Object.freeze({
    ...parseDatabaseConfig({
      connectionString: parsed.DATABASE_OPERATOR_URL,
      connectionTimeoutMillis: parsed.DATABASE_CONNECTION_TIMEOUT_MILLIS,
      idleTimeoutMillis: parsed.DATABASE_IDLE_TIMEOUT_MILLIS,
      max: 1,
      ownerRole: parsed.POSTGRES_OWNER_USER,
    }),
    operatorRole: parsed.POSTGRES_OPERATOR_USER,
  });
}

export function parseOutboxDispatcherConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseConfig {
  const parsed = dispatcherEnvironmentSchema.parse(environment);
  return parseDatabaseConfig({
    connectionString: parsed.DATABASE_DISPATCHER_URL,
    connectionTimeoutMillis: parsed.DATABASE_CONNECTION_TIMEOUT_MILLIS,
    idleTimeoutMillis: parsed.DATABASE_IDLE_TIMEOUT_MILLIS,
    max: parsed.DATABASE_DISPATCHER_POOL_MAX,
    ownerRole: parsed.POSTGRES_OWNER_USER,
    workerRuntimeRole: parsed.POSTGRES_WORKER_RUNTIME_USER,
  });
}
