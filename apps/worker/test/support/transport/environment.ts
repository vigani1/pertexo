import { randomUUID } from 'node:crypto';

export function transportFixtureSettings() {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
  const configuredMigrationUrl =
    process.env.DATABASE_MIGRATION_URL ??
    'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
  const configuredApiUrl =
    process.env.DATABASE_URL ??
    'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
  const configuredWorkerUrl =
    process.env.DATABASE_URL ??
    'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
  const configuredDispatcherUrl =
    process.env.DATABASE_MAINTENANCE_URL ??
    'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';
  const configuredRedisUrl =
    process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';

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
