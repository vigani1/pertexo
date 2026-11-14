import { testStackSetting } from '../../../../../infrastructure/testing/test-stack.mjs';
import { randomUUID } from 'node:crypto';

export function transportFixtureSettings() {
  const adminUrl = testStackSetting('DATABASE_ADMIN_URL');
  const configuredMigrationUrl = testStackSetting('DATABASE_MIGRATION_URL');
  const configuredApiUrl = testStackSetting('DATABASE_URL');
  const configuredWorkerUrl = testStackSetting('DATABASE_URL');
  const configuredDispatcherUrl = testStackSetting('DATABASE_MAINTENANCE_URL');
  const configuredRedisUrl = testStackSetting('REDIS_URL');

  const databaseName = `pertexo_test_transport_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = (base: string): string => {
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    return url.toString();
  };
  const migrationUrl = databaseUrl(configuredMigrationUrl);
  const apiUrl = databaseUrl(configuredApiUrl);
  const workerUrl = databaseUrl(configuredWorkerUrl);
  const dispatcherUrl = databaseUrl(configuredDispatcherUrl);
  const redisUrl = (() => {
    const url = new URL(configuredRedisUrl);
    url.pathname = '/11';
    return url.toString();
  })();

  const workspaceId = randomUUID();
  const actorId = randomUUID();

  return {
    adminUrl,
    databaseName,
    migrationUrl,
    apiUrl,
    workerUrl,
    dispatcherUrl,
    redisUrl,
    workspaceId,
    actorId,
  };
}
