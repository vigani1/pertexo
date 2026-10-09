import { z } from 'zod';

function postgresUrl(message: string) {
  return z.url().refine((value) => value.startsWith('postgresql://'), {
    message,
  });
}

function postgresRole(defaultRole: string) {
  return z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default(defaultRole);
}

const maximumPostgresTimeoutMillis = 2_147_483_647;
const connectionTimeoutMillis = z
  .number()
  .int()
  .positive()
  .max(maximumPostgresTimeoutMillis)
  .default(5_000);
const idleTimeoutMillis = z
  .number()
  .int()
  .positive()
  .max(maximumPostgresTimeoutMillis)
  .default(30_000);
const environmentConnectionTimeoutMillis = z.coerce
  .number()
  .int()
  .positive()
  .max(maximumPostgresTimeoutMillis)
  .default(5_000);
const environmentIdleTimeoutMillis = z.coerce
  .number()
  .int()
  .positive()
  .max(maximumPostgresTimeoutMillis)
  .default(30_000);
const conservativePoolMax = z.coerce
  .number()
  .int()
  .positive()
  .max(10)
  .default(2);
const runtimeEnvironmentFields = Object.freeze({
  DATABASE_CONNECTION_TIMEOUT_MILLIS: environmentConnectionTimeoutMillis,
  DATABASE_IDLE_TIMEOUT_MILLIS: environmentIdleTimeoutMillis,
  POSTGRES_OWNER_USER: postgresRole('pertexo_owner'),
});

const databaseConfigSchema = z.object({
  connectionString: postgresUrl('must be a postgresql:// URL'),
  connectionTimeoutMillis,
  idleTimeoutMillis,
  max: z.number().int().positive().max(100).default(10),
  ownerRole: postgresRole('pertexo_owner'),
});

export type DatabaseConfig = Readonly<z.output<typeof databaseConfigSchema>>;

export function parseDatabaseConfig(
  input: z.input<typeof databaseConfigSchema>,
): DatabaseConfig {
  return Object.freeze(databaseConfigSchema.parse(input));
}

const migrationEnvironmentSchema = z.object({
  DATABASE_MIGRATION_URL: postgresUrl(
    'DATABASE_MIGRATION_URL must be a postgresql:// URL',
  ),
  NODE_ENV: z
    .enum(['development', 'test', 'staging', 'production'])
    .default('development'),
  POSTGRES_OWNER_USER: postgresRole('pertexo_owner'),
  POSTGRES_APP_USER: postgresRole('pertexo_app'),
  POSTGRES_MAINTENANCE_USER: postgresRole('pertexo_maintenance'),
});

/** Owner runs migrations; app serves the API and worker; maintenance runs cross-workspace jobs. */
export type MigrationConfig = Readonly<{
  appRole: string;
  connectionString: string;
  maintenanceRole: string;
  ownerRole: string;
}>;

export function parseMigrationConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): MigrationConfig {
  const parsed = migrationEnvironmentSchema.parse(environment);
  return Object.freeze({
    appRole: parsed.POSTGRES_APP_USER,
    connectionString: parsed.DATABASE_MIGRATION_URL,
    maintenanceRole: parsed.POSTGRES_MAINTENANCE_USER,
    ownerRole: parsed.POSTGRES_OWNER_USER,
  });
}

const dispatcherEnvironmentSchema = z.object({
  ...runtimeEnvironmentFields,
  DATABASE_MAINTENANCE_URL: postgresUrl(
    'DATABASE_MAINTENANCE_URL must be a postgresql:// URL',
  ),
  DATABASE_DISPATCHER_POOL_MAX: conservativePoolMax,
});

const maintenanceEnvironmentSchema = z.object({
  ...runtimeEnvironmentFields,
  DATABASE_MAINTENANCE_URL: postgresUrl(
    'DATABASE_MAINTENANCE_URL must be a postgresql:// URL',
  ),
  DATABASE_MAINTENANCE_POOL_MAX: conservativePoolMax,
});

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
  });
}

/** Ops commands run one at a time on the maintenance login. */
export function parseOperatorDatabaseConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseConfig {
  return parseDatabaseConfig({
    ...parseMaintenanceDatabaseConfig(environment),
    max: 1,
  });
}

export function parseOutboxDispatcherConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseConfig {
  const parsed = dispatcherEnvironmentSchema.parse(environment);
  return parseDatabaseConfig({
    connectionString: parsed.DATABASE_MAINTENANCE_URL,
    connectionTimeoutMillis: parsed.DATABASE_CONNECTION_TIMEOUT_MILLIS,
    idleTimeoutMillis: parsed.DATABASE_IDLE_TIMEOUT_MILLIS,
    max: parsed.DATABASE_DISPATCHER_POOL_MAX,
    ownerRole: parsed.POSTGRES_OWNER_USER,
  });
}
