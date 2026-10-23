import { randomUUID } from 'node:crypto';

import { createRedisTestNamespace } from '../../infrastructure/redis-test-namespace.js';

export const workerTransportIntegrationEnabled =
  process.env.WORKER_TRANSPORT_INTEGRATION === 'true';

export const artifactStoreIntegrationEnabled =
  workerTransportIntegrationEnabled &&
  process.env.ARTIFACT_STORE_INTEGRATION === 'true';

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

export const maintenanceUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';

const configuredRedisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';

export const redisNamespace = createRedisTestNamespace(
  configuredRedisUrl,
  13,
  'preview-consumer',
);

export const redisUrl = redisNamespace.redisUrl;

export const databaseName = `pertexo_test_preview_transport_${randomUUID().replaceAll('-', '')}`;

export const workspaceId = randomUUID();

export const actorUserId = randomUUID();

export const workflowId = randomUUID();

export const workflowVersionId = randomUUID();

export const validateWorkflowGraph = {
  nodes: [
    {
      id: 'manual',
      definition: { key: 'core.manual', version: 1 },
      position: { x: 0, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {},
      connectionRefs: {},
    },
    {
      id: 'validate',
      definition: { key: 'core.validate', version: 1 },
      position: { x: 20, y: 0 },
      configVersion: 1,
      config: {
        rules: [
          {
            id: 'email',
            path: '$.profile.email',
            required: true,
            type: 'string',
            minLength: 8,
          },
          {
            id: 'role',
            path: '$.profile.role',
            type: 'string',
            enum: ['admin'],
          },
        ],
      },
      inputMappings: {
        profile: { kind: 'run_input' as const, path: '$.profile' },
        secret: { kind: 'run_input' as const, path: '$.secret' },
      },
      connectionRefs: {},
    },
  ],
  edges: [
    {
      id: 'manual-validate',
      source: { nodeId: 'manual', port: 'out' },
      target: { nodeId: 'validate', port: 'in' },
    },
  ],
  settings: {},
} as const;

export function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function redisConnectionOptions() {
  const parsed = new URL(redisUrl);
  return {
    db: Number(parsed.pathname.slice(1)),
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password === ''
      ? {}
      : { password: decodeURIComponent(parsed.password) }),
  };
}

export const validTraceparent =
  '00-' + 'c'.repeat(32) + '-' + 'd'.repeat(15) + '0-01';
