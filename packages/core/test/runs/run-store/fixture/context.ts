import { testStackSetting } from '../../../../../../infrastructure/testing/test-stack.mjs';
import { randomUUID } from 'node:crypto';

export const adminBaseUrl = testStackSetting('DATABASE_ADMIN_URL');

export const migrationBaseUrl = testStackSetting('DATABASE_MIGRATION_URL');

export const workerBaseUrl = testStackSetting('DATABASE_URL');

export const apiBaseUrl = testStackSetting('DATABASE_URL');

export const runnerOwnsDatabase =
  process.env.PERTEXO_Q11_RUNNER_OWNS_DATABASE === '1';

function validatedDatabaseName(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value))
    throw new Error('Q11 runner-owned database name is invalid');
  return value;
}

export const databaseName = (() => {
  if (!runnerOwnsDatabase)
    return `pertexo_test_0016_run_store_${randomUUID().replaceAll('-', '')}`;
  const value = process.env.PERTEXO_Q11_DATABASE_NAME;
  if (!value) throw new Error('Q11 runner-owned database name is required');
  return validatedDatabaseName(value);
})();

export const zeroDatabaseName = `pertexo_test_0016_zero_${randomUUID().replaceAll('-', '')}`;

export const priorHeadDatabaseName = `pertexo_test_0030_upgrade_${randomUUID().replaceAll('-', '')}`;

export const actorId = randomUUID();

export const workspaceA = randomUUID();

export const workspaceB = randomUUID();

export const workflowA = randomUUID();

export const workflowB = randomUUID();

export const versionA = randomUUID();

export const versionB = randomUUID();

export const notificationConnectionId = randomUUID();

export const notificationSecretVersionId = randomUUID();

export const notificationDestinationId = randomUUID();

export const coordinatorStoreApplicationName = `coordinator-fixture-${String(process.pid)}`;

export function namedDatabaseUrl(base: string, name: string): string {
  const value = new URL(base);
  value.pathname = `/${name}`;
  return value.toString();
}

export function databaseUrl(base: string): string {
  return namedDatabaseUrl(base, databaseName);
}

export function databaseUrlWithApplicationName(
  base: string,
  name: string,
): string {
  const value = new URL(databaseUrl(base));
  value.searchParams.set('application_name', name);
  return value.toString();
}

export const migrationConfig = {
  appRole: 'pertexo_app',
  connectionString: databaseUrl(migrationBaseUrl),
  maintenanceRole: 'pertexo_maintenance',
  ownerRole: 'pertexo_owner',
} as const;
