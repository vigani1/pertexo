import type { WorkspaceDatabase } from '@pertexo/database/testing';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';
import { vi } from 'vitest';

import type { BetterAuthRuntime } from '../../src/identity-infrastructure/index.js';
import type {
  IdentitySessionAuthority,
  IdentityWorkspaceDependencies,
} from '../../src/identity-workspace/index.js';
import type { ApiConfig } from '../../src/platform/config/api-config.js';
import type { ApiIdentityRuntime } from '../../src/platform/identity/identity-runtime.module.js';
import type { ApiWorkflowRuntime } from '../../src/platform/workflow/workflow-runtime.module.js';

export function createApiPlatformFixture(migrationHead: string) {
  const database: WorkspaceDatabase = {
    withWorkspace: async <T>(
      _workspaceId: string,
      operation: (transaction: never) => Promise<T>,
    ): Promise<T> => operation(undefined as never),
    checkReadiness: () =>
      Promise.resolve({
        migrationHead,
        postgresMajor: 18,
        role: 'pertexo_app',
      }),
    close: () => Promise.resolve(),
  };
  const config: ApiConfig = {
    database: {
      connectionString:
        'postgresql://pertexo_app:secret@localhost:5432/pertexo',
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 5,
      ownerRole: 'pertexo_owner',
    },
    host: '127.0.0.1',
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
        getWorkflow: () => Promise.resolve(null),
        getDraft: () => Promise.resolve(null),
        validateDraft: () => Promise.resolve(null),
        listVersions: () => Promise.resolve({ items: [] }),
        saveDraft: () => Promise.reject(new Error('not used')),
        publishWorkflow: () => Promise.reject(new Error('not used')),
        restoreWorkflowVersion: () => Promise.reject(new Error('not used')),
        duplicateWorkflow: () => Promise.reject(new Error('not used')),
        transitionWorkflowLifecycle: () =>
          Promise.reject(new Error('not used')),
        renameWorkflow: () => Promise.reject(new Error('not used')),
      },
    },
    runDependencies: {
      authorization,
      persistence: {
        start: () => Promise.reject(new Error('not used')),
        replay: () => Promise.reject(new Error('not used')),
        get: () => Promise.resolve(undefined),
        list: () => Promise.resolve({ items: [] }),
        readInput: () => Promise.resolve(undefined),
        readNodeRunOutput: () => Promise.resolve(undefined),
        readNodeRunInput: () => Promise.resolve(undefined),
        stepHealth: () => Promise.resolve(undefined),
        stepRuns: () => Promise.resolve(undefined),
        statistics: () => Promise.reject(new Error('not used')),
        usageCapacity: () => Promise.reject(new Error('not used')),
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

/**
 * An identity runtime whose session authority signs every presented session
 * cookie in as `userId`; access comes from `authorization`.
 */
export function createStubIdentityRuntime(
  userId: string,
  authorization: IdentityWorkspaceDependencies['authorization'],
): ApiIdentityRuntime {
  const notUsed = () => Promise.reject(new Error('not used'));
  const sessions: IdentitySessionAuthority = {
    issue: notUsed,
    authenticate: () =>
      Promise.resolve({
        userId,
        sessionId: '99999999-9999-4999-8999-999999999999',
        expiresAt: new Date('2099-08-22T20:00:00.000Z'),
        clientMetadata: {},
      }),
    revoke: () => Promise.resolve(),
    deliver: notUsed,
    signInEvidence: notUsed,
  };
  return Object.freeze({
    dependencies: {
      config: { publicWebOrigin: 'https://app.example.test' },
      persistence: {
        findUserById: () => Promise.resolve(null),
        listAccessibleWorkspaces: () => Promise.resolve({ items: [] }),
        listWorkspaceMembers: () => Promise.resolve({ items: [] }),
        changeWorkspaceMemberRole: notUsed,
        createWorkspaceWithOwner: notUsed,
        requestWorkspaceLifecycleOperation: notUsed,
        readWorkspaceLifecycleOperation: notUsed,
      },
      authorization,
      sessions,
    },
    betterAuth: {} as BetterAuthRuntime,
    close: () => Promise.resolve(),
  });
}
