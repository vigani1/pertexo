import { testStackSetting } from '../../../../../../infrastructure/testing/test-stack.mjs';
import { randomUUID } from 'node:crypto';

import { createRedisTestNamespace } from '../../infrastructure/redis-test-namespace.js';

export const workerTransportIntegrationEnabled =
  process.env.WORKER_TRANSPORT_INTEGRATION === 'true';

export const artifactStoreIntegrationEnabled =
  workerTransportIntegrationEnabled &&
  process.env.ARTIFACT_STORE_INTEGRATION === 'true';

export const adminUrl = testStackSetting('DATABASE_ADMIN_URL');

export const migrationUrl = testStackSetting('DATABASE_MIGRATION_URL');

export const apiUrl = testStackSetting('DATABASE_URL');

export const workerUrl = testStackSetting('DATABASE_URL');

export const dispatcherUrl = testStackSetting('DATABASE_MAINTENANCE_URL');

export const maintenanceUrl = testStackSetting('DATABASE_MAINTENANCE_URL');

const configuredRedisUrl = testStackSetting('REDIS_URL');

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
