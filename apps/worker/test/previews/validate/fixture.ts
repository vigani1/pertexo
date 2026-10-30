import { randomUUID } from 'node:crypto';
import { createDatabasePreviewAttemptRunStore } from '@pertexo/database/previews';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';

import { describe, vi } from 'vitest';

import { createPlatformPreviewNodeInvoker } from '../../../src/previews/runtime.js';
import {
  databaseUrl,
  redisUrl,
  workerTransportIntegrationEnabled,
  workerUrl,
} from '../../support/previews/consumer.js';
import { testNodeAttemptRuntime } from '../../support/runtime-factories.js';

export const describeIntegration = workerTransportIntegrationEnabled
  ? describe
  : describe.skip;

export const validateConfigInput = {
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
};

export async function createValidateRuntime() {
  const previewStore = createDatabasePreviewAttemptRunStore(
    parseDatabaseConfig({ connectionString: databaseUrl(workerUrl) }),
  );
  const registry = createPlatformNodeRegistry();
  const resolveConnection = vi.fn(() =>
    Promise.reject(new Error('Validate preview must not resolve a connection')),
  );
  const writeArtifact = vi.fn(() =>
    Promise.reject(new Error('Validate preview must not write an artifact')),
  );
  const runtime = await testNodeAttemptRuntime(
    {
      database: parseDatabaseConfig({
        connectionString: databaseUrl(workerUrl),
      }),
      heartbeatIntervalMillis: 200,
      leaseDurationSeconds: 10,
      preview: {
        invoker: createPlatformPreviewNodeInvoker({
          registry,
        }),
        runStore: previewStore,
      },
      redisUrl,
      workerId: `validate-preview-${randomUUID().slice(0, 8)}`,
    },
    {
      runtimeCapabilities: {
        connections: () => ({
          resolve: resolveConnection,
        }),
        artifacts: () => ({
          write: writeArtifact,
        }),
      },
    },
  );
  return Object.freeze({ resolveConnection, runtime, writeArtifact });
}
