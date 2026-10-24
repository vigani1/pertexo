export const ownerRole = process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner';

export const appRole = process.env.POSTGRES_APP_USER ?? 'pertexo_app';

export const maintenanceRole =
  process.env.POSTGRES_MAINTENANCE_USER ?? 'pertexo_maintenance';

export const migrationRole =
  process.env.POSTGRES_MIGRATION_USER ?? 'pertexo_migration';

export const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';

export const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

export const apiBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

export const workerBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

export const dispatcherBaseUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';

export const configuredRedisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';

/** The fixture acquires an exclusive lease for Redis database 15 before use. */
export const workflowLifecycleIntegrationRedisUrl = (() => {
  const parsed = new URL(configuredRedisUrl);
  parsed.pathname = '/15';
  return parsed.toString();
})();

export const workflowLifecycleIntegrationEnabled =
  process.env.WORKER_TRIGGER_INTEGRATION === 'true';
