import { testStackSetting } from '../../../../../infrastructure/testing/test-stack.mjs';
export const ownerRole = process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner';

export const appRole = process.env.POSTGRES_APP_USER ?? 'pertexo_app';

export const maintenanceRole =
  process.env.POSTGRES_MAINTENANCE_USER ?? 'pertexo_maintenance';

export const migrationRole =
  process.env.POSTGRES_MIGRATION_USER ?? 'pertexo_migration';

export const adminUrl = testStackSetting('DATABASE_ADMIN_URL');

export const migrationBaseUrl = testStackSetting('DATABASE_MIGRATION_URL');

export const apiBaseUrl = testStackSetting('DATABASE_URL');

export const workerBaseUrl = testStackSetting('DATABASE_URL');

export const dispatcherBaseUrl = testStackSetting('DATABASE_MAINTENANCE_URL');

export const configuredRedisUrl = testStackSetting('REDIS_URL');

/** The fixture acquires an exclusive lease for Redis database 15 before use. */
export const workflowLifecycleIntegrationRedisUrl = (() => {
  const parsed = new URL(configuredRedisUrl);
  parsed.pathname = '/15';
  return parsed.toString();
})();

export const workflowLifecycleIntegrationEnabled =
  process.env.WORKER_TRIGGER_INTEGRATION === 'true';
