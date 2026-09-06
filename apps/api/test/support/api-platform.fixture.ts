import type { WorkspaceDatabase } from '@pertexo/database/testing';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';
import { vi } from 'vitest';

import type { IdentityWorkspaceDependencies } from '../../src/identity-workspace/index.js';
import type { ApiConfig } from '../../src/platform/config/api-config.js';
import type { ApiWorkflowRuntime } from '../../src/platform/workflow/workflow-runtime.module.js';

export function createApiPlatformFixture(migrationHead: string) {
  const database: WorkspaceDatabase = {
    withWorkspace: async <T>(
      _workspaceId: string,
      operation: (transaction: never) => Promise<T>,
    ): Promise<T> => operation(undefined as never),
    checkCompatibility: () =>
      Promise.resolve({
        migrationHead,
        postgresMajor: 18,
        role: 'pertexo_api',
      }),
    checkReadiness: () =>
      Promise.resolve({
        migrationHead,
        postgresMajor: 18,
        role: 'pertexo_api',
      }),
    close: () => Promise.resolve(),
  };
  const config: ApiConfig = {
    database: {
      connectionString:
        'postgresql://pertexo_api:secret@localhost:5432/pertexo',
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 5,
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    },
    host: '127.0.0.1',
    nodeCompatibilityCohort: 'core',
    nodeEnv: 'test',
    observability: {
      environment: 'test',
      logLevel: 'silent',
      otlpHeaders: {},
      serviceName: 'pertexo-api',
      serviceVersion: 'test',
    },
    port: 3000,
    redisUrl: 'redis://localhost:6379/0',
  };
  const logger: StructuredLogger = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  };
  const telemetry: TelemetryLifecycle = {
    enabled: false,
    started: false,
    start: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
  const rateLimitConsumer = {
    consume: () => Promise.resolve({ allowed: true as const }),
  };
  return { config, database, logger, rateLimitConsumer, telemetry };
}

export function createStubApiWorkflowRuntime(
  authorization: IdentityWorkspaceDependencies['authorization'],
  close: () => Promise<void> = vi.fn().mockResolvedValue(undefined),
): ApiWorkflowRuntime {
  return Object.freeze({
    dependencies: {
      authorization,
      persistence: {
        createWorkflow: () => Promise.reject(new Error('not used')),
        listWorkflows: () => Promise.resolve({ items: [] }),
        getDraft: () => Promise.resolve(null),
        getVersion: () => Promise.resolve(null),
        listVersions: () => Promise.resolve({ items: [] }),
        saveDraft: () => Promise.reject(new Error('not used')),
        publishWorkflow: () => Promise.reject(new Error('not used')),
        transitionWorkflowLifecycle: () => Promise.reject(new Error('not used')),
      },
    },
    runDependencies: {
      authorization,
      persistence: {
        start: () => Promise.reject(new Error('not used')),
        replay: () => Promise.reject(new Error('not used')),
        get: () => Promise.resolve(undefined),
        cancel: () => Promise.reject(new Error('not used')),
      },
      streamer: {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            yield { id: 1, event: 'run.queued', data: '{}' };
          },
        }),
      },
    },
    close,
  });
}
