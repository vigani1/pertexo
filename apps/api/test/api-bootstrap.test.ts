import type {
  WorkflowAuthoringDatabase,
  WorkspaceDatabase,
} from '@pertexo/database/testing';
import type { TelemetryLifecycle } from '@pertexo/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createApiApplication,
  type ApiApplicationDependencies,
} from '../src/app.js';
import type { IdentityWorkspaceDependencies } from '../src/identity-workspace/index.js';
import {
  GetPreviewRunUseCase,
  TestWorkflowNodeUseCase,
} from '../src/node-testing/use-case.js';
import { ApiDrainState } from '../src/platform/health/drain-state.js';
import type { ApiIdentityRuntime } from '../src/platform/identity/identity-runtime.module.js';
import type { ApiConnectionRuntime } from '../src/platform/connections/connection-runtime.module.js';
import type { ApiWebhookRuntime } from '../src/platform/webhooks/webhook-runtime.module.js';
import type { WebhookManagementService } from '../src/webhooks/service.js';
import type { ApiScheduleRuntime } from '../src/platform/schedules/schedule-runtime.module.js';
import type { ApiArtifactRuntime } from '../src/platform/artifacts/artifact-runtime.module.js';
import { ScheduleManagementService } from '../src/schedules/service.js';
import {
  createApiPlatformFixture,
  createStubApiWorkflowRuntime,
} from './support/api-platform.fixture.js';

const { config, database, logger, rateLimitConsumer, telemetry } =
  createApiPlatformFixture('0000_rls_probe.sql');

function dependencies(
  selectedDatabase: WorkspaceDatabase = database,
  selectedTelemetry: TelemetryLifecycle = telemetry,
) {
  return {
    database: selectedDatabase,
    logger,
    rateLimitConsumer,
    telemetry: selectedTelemetry,
  };
}

function identityRuntime(
  close = vi.fn().mockResolvedValue(undefined),
  authenticated = false,
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
      findByDigest: () =>
        Promise.resolve(
          authenticated
            ? {
                sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
                tokenDigest: 'a'.repeat(64),
                userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                expiresAt: new Date(Date.now() + 60_000),
                clientMetadata: {},
              }
            : undefined,
        ),
      revokeByDigest: () => Promise.resolve(false),
      resolveOrCreateIdentity: () =>
        Promise.resolve({
          userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }),
      createWorkspaceWithOwner: () => Promise.reject(new Error('not used')),
      requestWorkspaceLifecycleOperation: () =>
        Promise.reject(new Error('not used')),
      readWorkspaceLifecycleOperation: () =>
        Promise.reject(new Error('not used')),
    },
    authorization: {
      findAccess: () =>
        Promise.resolve(
          authenticated
            ? {
                actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                role: 'owner' as const,
                membershipStatus: 'active' as const,
                workspaceStatus: 'active' as const,
              }
            : undefined,
        ),
    },
  };
  return Object.freeze({ dependencies: identityDependencies, close });
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
    restoreWorkflowVersion: () => Promise.reject(new Error('not used')),
    transitionWorkflowLifecycle: () => Promise.reject(new Error('not used')),
    close,
  };
}

function artifactRuntime(): ApiArtifactRuntime {
  return {
    dependencies: {
      authorization: identityRuntime().dependencies.authorization,
      database: {
        beginUpload: vi.fn(),
        finalizeUpload: vi.fn(),
        getForUpload: vi.fn(),
        getMetadata: vi.fn(),
      },
      store: {
        beginDirectUpload: vi.fn(),
        validateDirectUpload: vi.fn(),
        beginDirectDownload: vi.fn(),
        checkReadiness: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      },
    },
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('API bootstrap', () => {
  let application: Awaited<ReturnType<typeof createApiApplication>> | undefined;

  afterEach(async () => {
    await application?.close();
    application = undefined;
  });

  it('rejects contradictory provided and create-time runtime dependencies', async () => {
    const selectedIdentityRuntime = identityRuntime();
    const selectedWorkflowRuntime = createStubApiWorkflowRuntime(
      selectedIdentityRuntime.dependencies.authorization,
    );
    const selectedConnectionRuntime = {
      dependencies: {},
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as ApiConnectionRuntime;
    const cases = [
      {
        dependencies: {
          ...dependencies(),
          artifactRuntime: artifactRuntime(),
          artifactOverrides: {},
        },
        message: 'artifact runtime cannot be provided with artifact overrides',
      },
      {
        dependencies: {
          ...dependencies(),
          identityRuntime: selectedIdentityRuntime,
          identityOverrides: { clock: { now: () => new Date(0) } },
        },
        message: 'identity runtime cannot be provided with identity overrides',
      },
      {
        dependencies: {
          ...dependencies(),
          workflowRuntime: selectedWorkflowRuntime,
          workflowOverrides: {},
        },
        message: 'workflow runtime cannot be provided with workflow overrides',
      },
      {
        dependencies: {
          ...dependencies(),
          connectionRuntime: selectedConnectionRuntime,
          connectionOverrides: {},
        },
        message:
          'connection runtime cannot be provided with connection overrides',
      },
    ];

    for (const selected of cases)
      await expect(
        createApiApplication(
          config,
          selected.dependencies as unknown as ApiApplicationDependencies,
        ),
      ).rejects.toThrow(selected.message);
  });

  it('rejects runtime overrides that cannot participate in composition', async () => {
    const cases = [
      {
        dependencies: {
          ...dependencies(),
          identityRuntime: identityRuntime(),
          artifactOverrides: {},
        },
        message:
          'artifact overrides require configured artifact runtime creation',
      },
      {
        dependencies: { ...dependencies(), artifactRuntime: artifactRuntime() },
        message: 'feature runtimes require an available identity runtime',
      },
      {
        dependencies: { ...dependencies(), identityOverrides: {} },
        message:
          'identity overrides require configured identity runtime creation',
      },
      {
        dependencies: { ...dependencies(), workflowOverrides: {} },
        message:
          'workflow overrides require available identity runtime creation',
      },
      {
        dependencies: {
          ...dependencies(),
          identityRuntime: identityRuntime(),
          connectionOverrides: {},
        },
        message:
          'connection overrides require configured connection runtime creation',
      },
      {
        dependencies: {
          ...dependencies(),
          workflowRuntime: createStubApiWorkflowRuntime(
            identityRuntime().dependencies.authorization,
          ),
        },
        message: 'feature runtimes require an available identity runtime',
      },
    ];

    for (const selected of cases)
      await expect(
        createApiApplication(
          config,
          selected.dependencies as unknown as ApiApplicationDependencies,
        ),
      ).rejects.toThrow(selected.message);
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
    const checkCompatibility = vi.fn(() => database.checkCompatibility());
    const checkReadiness = vi.fn(() => database.checkReadiness());
    const selectedDatabase: WorkspaceDatabase = {
      ...database,
      checkCompatibility,
      checkReadiness,
    };
    application = await createApiApplication(
      config,
      dependencies(selectedDatabase),
    );
    await application.init();

    const response = await application.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
    expect(checkCompatibility).toHaveBeenCalledOnce();
    expect(checkReadiness).toHaveBeenCalledOnce();
  });

  it('returns 503 without exposing a database readiness failure', async () => {
    const readiness = {
      migrationHead: '0000_rls_probe.sql',
      postgresMajor: 18,
      role: 'pertexo_api',
    } as const;
    const unavailableDatabase: WorkspaceDatabase = {
      ...database,
      checkCompatibility: vi.fn().mockResolvedValue(readiness),
      checkReadiness: vi
        .fn()
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
      checkCompatibility: vi
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
      workflowRuntime: createStubApiWorkflowRuntime(
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

  it('registers the encapsulated webhook route and closes its runtime', async () => {
    const selectedIdentityRuntime = identityRuntime();
    const webhookClose = vi.fn().mockResolvedValue(undefined);
    const webhookRuntime = {
      service: {} as WebhookManagementService,
      ingress: {
        database: {
          resolveVerification: vi.fn().mockResolvedValue(null),
        },
        encryption: {},
        checkpointFactory: () => ({ engineVersion: 'test', checkpoint: {} }),
      },
      close: webhookClose,
    } as unknown as ApiWebhookRuntime;
    application = await createApiApplication(config, {
      ...dependencies(),
      identityRuntime: selectedIdentityRuntime,
      webhookRuntime,
    });

    const response = await application.inject({
      method: 'POST',
      url: `/hooks/${'a'.repeat(43)}`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ code: string }>().code).toBe(
      'webhook.authentication_failed',
    );

    const management = await application.inject({
      method: 'GET',
      url: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflows/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/triggers',
    });
    expect(management.statusCode).toBe(401);

    await application.close();
    application = undefined;
    expect(webhookClose).toHaveBeenCalledOnce();
  });

  it('enforces session and CSRF on schedule routes and owns readiness and close', async () => {
    const selectedIdentityRuntime = identityRuntime(
      vi.fn().mockResolvedValue(undefined),
      true,
    );
    const record = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      workflowId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      workflowVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      nodeId: 'schedule',
      kind: 'schedule' as const,
      status: 'active' as const,
      healthStatus: 'healthy' as const,
      lastErrorCode: null,
      reconciledAt: null,
      recurrence: { kind: 'interval' as const, intervalMinutes: 5 },
      misfirePolicy: 'catch_up_once' as const,
      nextFireAt: new Date('2026-08-25T12:05:00.000Z'),
      lastFireAt: null,
    };
    const scheduleDatabase = {
      list: vi.fn().mockResolvedValue([record]),
      setEnabled: vi
        .fn()
        .mockResolvedValue({ trigger: record, replayed: false }),
      checkReadiness: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const scheduleRuntime = {
      service: new ScheduleManagementService(scheduleDatabase),
      checkReadiness: scheduleDatabase.checkReadiness,
      close: scheduleDatabase.close,
    } as ApiScheduleRuntime;
    application = await createApiApplication(config, {
      ...dependencies(),
      identityRuntime: selectedIdentityRuntime,
      scheduleRuntime,
    });
    const base =
      '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflows/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/triggers';
    const unauthenticated = await application.inject({
      method: 'GET',
      url: `${base}/schedules`,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const cookie = `pertexo_session=${'s'.repeat(43)}`;
    const hidden = await application.inject({
      method: 'GET',
      url: `${base.replace('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')}/schedules`,
      headers: { cookie },
    });
    expect(hidden.statusCode).toBe(404);

    const listed = await application.inject({
      method: 'GET',
      url: `${base}/schedules`,
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ items: [{ kind: 'schedule' }] });

    const missingCsrf = await application.inject({
      method: 'POST',
      url: `${base}/${record.id}/schedule/disable`,
      headers: { cookie, 'idempotency-key': 'disable' },
      payload: {},
    });
    expect(missingCsrf.statusCode).toBe(403);

    const csrf = 'c'.repeat(32);
    const missingKey = await application.inject({
      method: 'POST',
      url: `${base}/${record.id}/schedule/disable`,
      headers: {
        cookie: `${cookie}; pertexo_csrf=${csrf}`,
        'x-csrf-token': csrf,
      },
      payload: {},
    });
    expect(missingKey.statusCode).toBe(428);

    const disabled = await application.inject({
      method: 'POST',
      url: `${base}/${record.id}/schedule/disable`,
      headers: {
        cookie: `${cookie}; pertexo_csrf=${csrf}`,
        'x-csrf-token': csrf,
        'idempotency-key': 'disable',
      },
      payload: {},
    });
    expect(disabled.statusCode).toBe(200);
    expect(scheduleDatabase.setEnabled).toHaveBeenCalledOnce();
    expect(scheduleDatabase.checkReadiness).toHaveBeenCalled();

    await application.close();
    application = undefined;
    expect(scheduleDatabase.close).toHaveBeenCalledOnce();
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
          replay: () => Promise.reject(new Error('not used')),
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
      url: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflows/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/draft/nodes/cccccccc-cccc-4ccc-8ccc-cccccccccccc/test',
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
      checkCompatibility: vi
        .fn()
        .mockRejectedValue(new Error('migration mismatch')),
    };

    await expect(
      createApiApplication(config, {
        ...dependencies(incompatibleDatabase),
        identityRuntime: selectedIdentityRuntime,
        workflowRuntime: createStubApiWorkflowRuntime(
          selectedIdentityRuntime.dependencies.authorization,
          workflowClose,
        ),
      }),
    ).rejects.toThrow('migration mismatch');
    expect(identityClose).toHaveBeenCalledOnce();
    expect(workflowClose).toHaveBeenCalledOnce();
  });

  it('closes identity and artifact runtimes when artifact startup readiness fails', async () => {
    const selectedIdentity = identityRuntime();
    const selectedArtifacts = artifactRuntime();
    vi.mocked(selectedArtifacts.checkReadiness).mockRejectedValue(
      new Error('artifact readiness failed'),
    );
    await expect(
      createApiApplication(config, {
        ...dependencies(),
        identityRuntime: selectedIdentity,
        artifactRuntime: selectedArtifacts,
      }),
    ).rejects.toThrow('artifact readiness failed');
    expect(selectedIdentity.close).toHaveBeenCalledOnce();
    expect(selectedArtifacts.close).toHaveBeenCalledOnce();
  });

  it('includes artifact readiness in health and closes its runtime once', async () => {
    const selectedArtifacts = artifactRuntime();
    application = await createApiApplication(config, {
      ...dependencies(),
      identityRuntime: identityRuntime(),
      artifactRuntime: selectedArtifacts,
    });
    expect(selectedArtifacts.checkReadiness).toHaveBeenCalledOnce();
    vi.mocked(selectedArtifacts.checkReadiness).mockRejectedValue(
      new Error('private bucket detail'),
    );
    const response = await application.inject({
      method: 'GET',
      url: '/health/ready',
    });
    expect(response.statusCode).toBe(503);
    expect(response.payload).not.toContain('private bucket detail');
    await application.close();
    application = undefined;
    expect(selectedArtifacts.close).toHaveBeenCalledOnce();
  });
});
