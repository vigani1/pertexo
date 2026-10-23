import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createRedisTestNamespace } from '../../infrastructure/redis-test-namespace.js';

export const enabled = process.env.WORKER_TRANSPORT_INTEGRATION === 'true';

export const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';

export const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

export const apiUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

export const workerUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

export const dispatcherUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';

const configuredRedisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';

export const databaseName = `pertexo_test_retained_core_${randomUUID().replaceAll('-', '')}`;

export const repositoryRoot = fileURLToPath(
  new URL('../../../../../../', import.meta.url),
);

export function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export const redisNamespace = createRedisTestNamespace(
  configuredRedisUrl,
  12,
  'coordinator-consumer',
);

export const redisUrl = redisNamespace.redisUrl;

export const actorId = randomUUID();

export const workspaceId = randomUUID();

export const workflowId = randomUUID();

export const workflowVersionId = randomUUID();

export const conditionWorkflowId = randomUUID();

export const conditionWorkflowVersionId = randomUUID();

export const switchWorkflowId = randomUUID();

export const switchWorkflowVersionId = randomUUID();

export const parallelWorkflowId = randomUUID();

export const parallelWorkflowVersionId = randomUUID();

export const forEachWorkflowId = randomUUID();

export const forEachWorkflowVersionId = randomUUID();

export const nestedParallelWorkflowId = randomUUID();

export const nestedParallelWorkflowVersionId = randomUUID();

export const waitWorkflowId = randomUUID();

export const waitWorkflowVersionId = randomUUID();

export function redisConnection(): {
  db: number;
  host: string;
  password?: string;
  port: number;
} {
  const parsed = new URL(redisUrl);
  return {
    db: Number(parsed.pathname.slice(1) || '0'),
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password === ''
      ? {}
      : { password: decodeURIComponent(parsed.password) }),
  };
}
