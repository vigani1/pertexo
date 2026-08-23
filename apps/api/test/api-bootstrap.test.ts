import type {
  WorkflowAuthoringDatabase,
  WorkspaceDatabase,
} from '@pertexo/database';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApiApplication } from '../src/app.js';
import type { IdentityWorkspaceDependencies } from '../src/identity-workspace/index.js';
import {
  GetPreviewRunUseCase,
  TestWorkflowNodeUseCase,
} from '../src/node-testing/use-case.js';
import { ApiDrainState } from '../src/platform/health/drain-state.js';
import type { ApiIdentityRuntime } from '../src/platform/identity/identity-runtime.module.js';
import type { ApiWorkflowRuntime } from '../src/platform/workflow/workflow-runtime.module.js';

const database: WorkspaceDatabase = {
  withWorkspace: async <T>(
    _workspaceId: string,
    operation: (transaction: never) => Promise<T>,
  ): Promise<T> => operation(undefined as never),
  checkReadiness: () =>
    Promise.resolve({
      migrationHead: '0000_rls_probe.sql',
      postgresMajor: 18,
      role: 'pertexo_api',
    }),
  close: () => Promise.resolve(),
};

const config = {
  database: {
    connectionString: 'postgresql://pertexo_api:secret@localhost:5432/pertexo',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 5,
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  },
  host: '127.0.0.1',
  nodeCompatibilityCohort: 'core' as const,
  nodeEnv: 'test' as const,
  observability: {
    environment: 'test' as const,
    logLevel: 'silent' as const,
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

function dependencies(
  selectedDatabase: WorkspaceDatabase = database,
  selectedTelemetry: TelemetryLifecycle = telemetry,
) {
  return { database: selectedDatabase, logger, telemetry: selectedTelemetry };
}

function identityRuntime(
  close = vi.fn().mockResolvedValue(undefined),
): ApiIdentityRuntime {
  const identityDependencies: IdentityWorkspaceDependencies = {
    config: {
      oidc: {
        issuer: 'https://identity.example.test',
        authorizationEndpoint: 'https://identity.example.test/authorize',
        clientId: 'client',
        redirectUri: 'https://api.example.test/v1/auth/oidc/callback',
        scopes: ['openid'],
        transactionTtlMillis: 300_000,
      },
    },
    provider: {
      authorizationUrl: () => 'https://identity.example.test/authorize',
      exchangeCode: () => Promise.reject(new Error('not used')),
    },
    transactions: {
      create: () => Promise.resolve(),
      consume: () => Promise.resolve({ status: 'missing' }),
    },
    persistence: {
      create: () => Promise.resolve(),
      findByDigest: () => Promise.resolve(undefined),
      revokeByDigest: () => Promise.resolve(false),
      resolveOrCreateIdentity: () =>
        Promise.resolve({
          userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }),
      createWorkspaceWithOwner: () => Promise.reject(new Error('not used')),
      requestWorkspaceDeletion: () => Promise.reject(new Error('not used')),
      restoreWorkspace: () => Promise.reject(new Error('not used')),
    },
    authorization: { findAccess: () => Promise.resolve(undefined) },
  };
  return Object.freeze({ dependencies: identityDependencies, close });
}

function workflowRuntime(
  authorization: IdentityWorkspaceDependencies['authorization'],
  close = vi.fn().mockResolvedValue(undefined),
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
      },
    },
    runDependencies: {
      authorization,
      persistence: {
        start: () => Promise.reject(new Error('not used')),
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

function workflowAuthoringDatabase(
  close = vi.fn().mockResolvedValue(undefined),
): WorkflowAuthoringDatabase {
  return {
    acceptPreview: () => Promise.reject(new Error('not used')),
    readPreview: () => Promise.resolve(null),
    createWorkflow: () => Promise.reject(new Error('not used')),
    listWorkflows: () => Promise.resolve({ items: [] }),
    getDraft: () => Promise.resolve(null),
    getVersion: () => Promise.resolve(null),
    listVersions: () => Promise.resolve({ items: [] }),
    saveDraft: () => Promise.reject(new Error('not used')),
    publishWorkflow: () => Promise.reject(new Error('not used')),
    close,
  };
}

describe('API bootstrap', () => {
  let application: Awaited<ReturnType<typeof createApiApplication>> | undefined;

  afterEach(async () => {
    await application?.close();
    application = undefined;
  });

  it('serves a stable bounded liveness response without dependency claims', async () => {
    application = await createApiApplication(config, dependencies());
    await application.init();

    const response = await application.inject({
      method: 'GET',
      url: '/health/live',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.payload).toBe('{"status":"ok"}');
    expect(response.payload.length).toBeLessThanOrEqual(64);
  });

  it('reports readiness only after database compatibility passes', async () => {
    application = await createApiApplication(config, dependencies());
    await application.init();

    const response = await application.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
  });

  it('returns 503 without exposing a database readiness failure', async () => {
    const readiness = {
      migrationHead: '0000_rls_probe.sql',
      postgresMajor: 18,
      role: 'pertexo_api',
    } as const;
    const unavailableDatabase: WorkspaceDatabase = {
      ...database,
      checkReadiness: vi
        .fn()
        .mockResolvedValueOnce(readiness)
        .mockRejectedValue(new Error('secret database detail')),
    };
    application = await createApiApplication(
      config,
      dependencies(unavailableDatabase),
    );
    await application.init();

    const response = await application.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(503);
    expect(response.payload).not.toContain('secret database detail');
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.headers['x-request-id']).toBeTypeOf('string');
    expect(response.json()).toMatchObject({
      code: 'internal.unexpected',
      requestId: response.headers['x-request-id'],
      status: 503,
    });
  });

  it('refuses to start and closes resources against an incompatible database', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const incompatibleDatabase: WorkspaceDatabase = {
      ...database,
      checkReadiness: vi
        .fn()
        .mockRejectedValue(new Error('migration mismatch')),
      close,
    };

    await expect(
      createApiApplication(config, dependencies(incompatibleDatabase)),
    ).rejects.toThrow('migration mismatch');
    expect(close).toHaveBeenCalledOnce();
  });

  it('becomes unready before graceful drain', async () => {
    application = await createApiApplication(config, dependencies());
    await application.init();
    application.get(ApiDrainState).beginDrain();

    const response = await application.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(503);
  });

  it('enters drain state before shutdown resources close', async () => {
    const lifecycle: { drainState?: ApiDrainState } = {};
    const close = vi.fn().mockImplementation(() => {
      expect(lifecycle.drainState?.isDraining()).toBe(true);
      return Promise.resolve();
    });
    const selectedDatabase: WorkspaceDatabase = { ...database, close };
    const selectedApplication = await createApiApplication(
      config,
      dependencies(selectedDatabase),
    );
    lifecycle.drainState = selectedApplication.get(ApiDrainState);
    application = selectedApplication;
    await application.close();
    application = undefined;

    expect(close).toHaveBeenCalledOnce();
  });

  it('shuts telemetry down with the Nest application lifecycle', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const selectedTelemetry: TelemetryLifecycle = {
      enabled: true,
      started: true,
      start: vi.fn(),
      shutdown,
    };
    application = await createApiApplication(
      config,
      dependencies(database, selectedTelemetry),
    );
    await application.init();
    await application.close();
    application = undefined;

    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('registers an injected identity runtime and owns its close lifecycle', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const selectedIdentityRuntime = identityRuntime(close);
    application = await createApiApplication(config, {
      ...dependencies(),
      identityRuntime: selectedIdentityRuntime,
    });
    await application.init();

    const response = await application.inject({
      method: 'GET',
      url: '/v1/auth/oidc/start',
    });
    expect(response.statusCode).toBe(200);

    await application.close();
    application = undefined;
    expect(close).toHaveBeenCalledOnce();
  });

  it('registers workflow routes and closes identity and workflow runtimes together', async () => {
    const identityClose = vi.fn().mockResolvedValue(undefined);
    const workflowClose = vi.fn().mockResolvedValue(undefined);
    const selectedIdentityRuntime = identityRuntime(identityClose);
    application = await createApiApplication(config, {
      ...dependencies(),
      identityRuntime: selectedIdentityRuntime,
      workflowRuntime: workflowRuntime(
        selectedIdentityRuntime.dependencies.authorization,
        workflowClose,
      ),
    });
    await application.init();

    const response = await application.inject({
      method: 'GET',
      url: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflows',
    });
    expect(response.statusCode).toBe(401);

    const runResponse = await application.inject({
      method: 'GET',
      url: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/runs/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    expect(runResponse.statusCode).toBe(401);

    await application.close();
    application = undefined;
    expect(identityClose).toHaveBeenCalledOnce();
    expect(workflowClose).toHaveBeenCalledOnce();
  });

  it('registers node-testing routes and providers with the production workflow runtime', async () => {
    const selectedIdentityRuntime = identityRuntime();
    application = await createApiApplication(config, {
      ...dependencies(),
      identityRuntime: selectedIdentityRuntime,
      workflowOverrides: {
        database: workflowAuthoringDatabase(),
        runPersistence: {
          start: () => Promise.reject(new Error('not used')),
          get: () => Promise.resolve(undefined),
          cancel: () => Promise.reject(new Error('not used')),
        },
        runStreamer: {
          stream: () => ({
            async *[Symbol.asyncIterator]() {
              await Promise.resolve();
              yield { id: 1, event: 'run.queued', data: '{}' };
            },
          }),
        },
      },
    });
    await application.init();

    expect(application.get(TestWorkflowNodeUseCase)).toBeInstanceOf(
      TestWorkflowNodeUseCase,
    );
    expect(application.get(GetPreviewRunUseCase)).toBeInstanceOf(
      GetPreviewRunUseCase,
    );

    const testResponse = await application.inject({
      method: 'POST',
      url: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflows/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/nodes/cccccccc-cccc-4ccc-8ccc-cccccccccccc/test',
      payload: { mode: 'validate' },
    });
    expect(testResponse.statusCode).toBe(401);

    const previewResponse = await application.inject({
      method: 'GET',
      url: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/previews/dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });
    expect(previewResponse.statusCode).toBe(401);
  });

  it('closes an injected identity runtime when database readiness fails', async () => {
    const identityClose = vi.fn().mockResolvedValue(undefined);
    const workflowClose = vi.fn().mockResolvedValue(undefined);
    const selectedIdentityRuntime = identityRuntime(identityClose);
    const incompatibleDatabase: WorkspaceDatabase = {
      ...database,
      checkReadiness: vi
        .fn()
        .mockRejectedValue(new Error('migration mismatch')),
    };

    await expect(
      createApiApplication(config, {
        ...dependencies(incompatibleDatabase),
        identityRuntime: selectedIdentityRuntime,
        workflowRuntime: workflowRuntime(
          selectedIdentityRuntime.dependencies.authorization,
          workflowClose,
        ),
      }),
    ).rejects.toThrow('migration mismatch');
    expect(identityClose).toHaveBeenCalledOnce();
    expect(workflowClose).toHaveBeenCalledOnce();
  });
});
