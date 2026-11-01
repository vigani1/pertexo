import { queuedCheckpoint } from '../../support/checkpoint.js';
import { createHash, randomUUID } from 'node:crypto';
import type { WebhookRequest } from '@pertexo/nodes-core';

import { parseDatabaseConfig } from '@pertexo/database/platform';

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

export const databaseName = `pertexo_test_webhook_${randomUUID().replaceAll('-', '')}`;

export const url = (base: string): string => {
  const parsed = new URL(base);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
};

export const actorId = randomUUID();

export const workspaceId = randomUUID();

export const workflowId = randomUUID();

export const versionId = randomUUID();

export const triggerId = randomUUID();

export const endpointId = randomUUID();

export const outboxEventId = randomUUID();

export const notificationConnectionId = randomUUID();

export const notificationSecretVersionId = randomUUID();

export const notificationDestinationId = randomUUID();

export const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export const endpointHash = hash('endpoint-one');

export const secret = (id = randomUUID()) => ({
  id,
  kmsKeyReference: 'kms://test/webhook',
  encryptedDataKey: `encrypted-key-${id}`,
  ciphertext: `ciphertext-${id}`,
  nonce: 'nonce-value',
  authTag: 'authentication-tag',
});

export const migrationConfig = {
  connectionString: url(migrationBaseUrl),
  ownerRole: 'pertexo_owner',
  appRole: 'pertexo_app',
  maintenanceRole: 'pertexo_maintenance',
} as const;

export const apiConfig = parseDatabaseConfig({
  connectionString: url(apiBaseUrl),
  max: 8,
});

export const workerConfig = parseDatabaseConfig({
  connectionString: url(workerBaseUrl),
  max: 8,
});

export const post = (body: unknown): WebhookRequest => ({
  method: 'POST',
  body,
  query: {},
  headers: {},
});

export const triggerCatalog = Object.freeze({
  definitions: Object.freeze([
    Object.freeze({ key: 'core.webhook', version: 1 }),
    Object.freeze({ key: 'core.schedule', version: 1 }),
  ]),
});

export const checkpointFactory = (projection?: { id: string }) =>
  queuedCheckpoint(projection?.id ?? versionId);

export function triggerGraph(intervalMinutes = 15, graphDisabled = false) {
  return {
    settings: {},
    nodes: [
      {
        id: 'webhook',
        disabled: graphDisabled,
        definition: { key: 'core.webhook', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'schedule',
        disabled: graphDisabled,
        definition: { key: 'core.schedule', version: 1 },
        position: { x: 0, y: 100 },
        configVersion: 1,
        config: {
          kind: 'interval',
          intervalMinutes,
          misfirePolicy: 'skip',
        },
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [],
  };
}
