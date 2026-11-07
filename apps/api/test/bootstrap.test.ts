import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanAPIBootstrapOwnershipHealthFixture,
  config,
  dependencies,
  applicationFixture,
  database,
  identityRuntime,
  betterAuthIdentityConfig,
  betterAuthIdentityRuntime,
  nodeTestingWorkflowRuntime,
  workflowAuthoringDatabase,
  artifactRuntime,
} from './bootstrap/fixture.js';
import { createTestApiApplication } from './support/api-application.js';
import type { WorkspaceDatabase } from '@pertexo/database/testing';
import { ApiDrainState } from '../src/platform/health/drain-state.js';
import { ReadyController } from '../src/platform/health/ready.controller.js';
import { request as httpRequest } from 'node:http';
import type { ApiWorkflowRuntime } from '../src/platform/workflow/workflow-runtime.module.js';
import { createStubApiWorkflowRuntime } from './support/api-platform.fixture.js';
import type { TelemetryLifecycle } from '@pertexo/observability/server';
import type { ApiWebhookRuntime } from '../src/platform/webhooks/webhooks-runtime.module.js';
import type { WebhookManagementService } from '../src/webhooks/management/webhook-management.service.js';
import { EMPTY_WORKFLOW_GRAPH } from '@pertexo/workflow-model';
import {
  AuthoringValidationUnavailableError,
  EMPTY_DEFINITION_CATALOG,
  workflowCompatibilityReport,
} from '@pertexo/workflow-model/server';
import { createDraftRepresentationTag } from '../src/workflow-authoring/http/etag.js';
import { createBetterAuthFixtureApplication } from './support/better-auth/fixture-application.js';
import { FixtureResourceOwner } from './browser/harness/resource-owner.js';
import {
  createApiScheduleRuntime,
  type ApiScheduleRuntime,
} from '../src/platform/schedules/schedules-runtime.module.js';
import type { ApiNotificationRuntime } from '../src/platform/notifications/notifications-runtime.module.js';
import { WorkspaceInboxService } from '../src/notifications/workspace-inbox.service.js';
import { ScheduleManagementService } from '../src/schedules/schedule-management.service.js';
import { NOOP_SCHEDULE_TELEMETRY } from '../src/schedules/telemetry.js';
import {
  GetPreviewRunUseCase,
  TestWorkflowNodeUseCase,
} from '../src/node-testing/node-testing.service.js';

describe('API bootstrap ownership and health', () => {
  afterEach(cleanAPIBootstrapOwnershipHealthFixture);
  it('accepts both empty and populated trusted-proxy CIDR configuration', async () => {
    applicationFixture.application = await createTestApiApplication(
      { ...config, trustedProxyCidrs: [] },
      dependencies(),
    );
    await applicationFixture.application.close();
    applicationFixture.application = await createTestApiApplication(
      { ...config, trustedProxyCidrs: ['127.0.0.1/32'] },
      dependencies(),
    );
    expect(
      (
        await applicationFixture.application.inject({
          method: 'GET',
          url: '/health/live',
        })
      ).statusCode,
    ).toBe(200);
  });

  it.each([
    '/v1/workspaces/nonexistent',
    '/v1/workspaces/workspace-a/workflows/nonexistent/nested',
  ])('keeps an unknown feature-family route at 404: %s', async (url) => {
    applicationFixture.application = await createTestApiApplication(
      config,
      dependencies(),
    );
    await applicationFixture.application.init();

    const response = await applicationFixture.application.inject({
      method: 'GET',
      url,
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.json()).toMatchObject({
      status: 404,
      code: 'resource.not_found',
    });
  });

  it('preserves readiness and cleanup failures when application close rejects', async () => {
    const startupFailure = new Error('database compatibility failed');
    const cleanupFailure = new Error('identity cleanup failed');
    const selectedDatabase: WorkspaceDatabase = {
      ...database,
      checkReadiness: vi.fn().mockRejectedValue(startupFailure),
    };
    const selectedIdentity = identityRuntime(
      vi.fn().mockRejectedValue(cleanupFailure),
    );

    const failure = await createTestApiApplication(config, {
      ...dependencies(selectedDatabase),
      identityRuntime: selectedIdentity,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      startupFailure,
      cleanupFailure,
    ]);
  });

  it('serves a stable bounded liveness response without dependency claims', async () => {
    applicationFixture.application = await createTestApiApplication(
      config,
      dependencies(),
    );
    await applicationFixture.application.init();

    const response = await applicationFixture.application.inject({
      method: 'GET',
      url: '/health/live',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.payload).toBe('{"status":"ok"}');
    expect(response.payload.length).toBeLessThanOrEqual(64);
  });

  it('checks the database at startup and again when asked for readiness', async () => {
    const checkReadiness = vi.fn(() => database.checkReadiness());
    const selectedDatabase: WorkspaceDatabase = {
      ...database,
      checkReadiness,
    };
    applicationFixture.application = await createTestApiApplication(
      config,
      dependencies(selectedDatabase),
    );
    await applicationFixture.application.init();

    const response = await applicationFixture.application.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
    expect(checkReadiness).toHaveBeenCalledTimes(2);
  });

  it('returns 503 without exposing a database readiness failure', async () => {
    const readiness = {
      migrationHead: '0000_rls_probe.sql',
      postgresMajor: 18,
      role: 'pertexo_app',
    } as const;
    const unavailableDatabase: WorkspaceDatabase = {
      ...database,
      // Ready at startup, then unavailable.
      checkReadiness: vi
        .fn()
        .mockResolvedValueOnce(readiness)
        .mockRejectedValue(new Error('secret database detail')),
    };
    applicationFixture.application = await createTestApiApplication(
      config,
      dependencies(unavailableDatabase),
    );
    await applicationFixture.application.init();

    const response = await applicationFixture.application.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(503);
    expect(response.payload).not.toContain('secret database detail');
    expect(response.headers['x-request-id']).toBeTypeOf('string');
    expect(response.json()).toEqual({ status: 'not_ready' });
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
      createTestApiApplication(config, dependencies(incompatibleDatabase)),
    ).rejects.toThrow('migration mismatch');
    expect(close).toHaveBeenCalledOnce();
  });

  it('becomes unready before graceful drain', async () => {
    applicationFixture.application = await createTestApiApplication(
      config,
      dependencies(),
    );
    await applicationFixture.application.init();
    applicationFixture.application.get(ApiDrainState).beginDrain();

    const response = await applicationFixture.application.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(503);
  });

  it('does not restore readiness when drain begins during a pending health check', async () => {
    type Readiness = Awaited<ReturnType<WorkspaceDatabase['checkReadiness']>>;
    let resolveReadiness!: (value: Readiness) => void;
    const pendingReadiness = new Promise<Readiness>((resolve) => {
      resolveReadiness = resolve;
    });
    const checkReadiness = vi.fn(() => pendingReadiness);
    const drain = new ApiDrainState();
    const controller = new ReadyController(
      { ...database, checkReadiness },
      drain,
    );

    const response = controller.ready();
    await vi.waitFor(() => {
      expect(checkReadiness).toHaveBeenCalledOnce();
    });
    drain.beginDrain();
    resolveReadiness({
      migrationHead: '0000_rls_probe.sql',
      postgresMajor: 18,
      role: 'pertexo_app',
    });

    await expect(response).rejects.toMatchObject({ status: 503 });
  });

  it('aborts application-owned streams when drain begins', () => {
    const drain = new ApiDrainState();
    const stream = new AbortController();
    const release = drain.registerStream(stream);

    drain.beginDrain();

    expect(stream.signal.aborted).toBe(true);
    expect(drain.activeStreamCount()).toBe(1);
    release();
    expect(drain.activeStreamCount()).toBe(0);
  });

  describe('SSE transport shutdown', () => {
    it('closes a real open SSE request without client cooperation', async () => {
      const selectedIdentityRuntime = identityRuntime(
        vi.fn().mockResolvedValue(undefined),
        true,
      );
      const baseRuntime = createStubApiWorkflowRuntime(
        selectedIdentityRuntime.dependencies.authorization,
      );
      let producerClosed = false;
      const selectedWorkflowRuntime: ApiWorkflowRuntime = {
        ...baseRuntime,
        runDependencies: {
          ...baseRuntime.runDependencies,
          persistence: {
            ...baseRuntime.runDependencies.persistence,
            get: () =>
              Promise.resolve({
                run: {
                  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                  workflowId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                  workflowVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                  status: 'running' as const,
                  replaySourceRunId: null,
                  failureReasonCode: null,
                  triggerType: 'manual' as const,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                  startedAt: new Date(),
                  completedAt: null,
                  deadlineAt: null,
                  cancelRequestedAt: null,
                },
                nodes: [],
              }),
          },
          streamer: {
            stream: ({ signal }) => ({
              async *[Symbol.asyncIterator]() {
                try {
                  yield {
                    id: 1,
                    event: 'run.started',
                    data: JSON.stringify({
                      sequence: 1,
                      type: 'run.started',
                      createdAt: new Date().toISOString(),
                      payload: {},
                    }),
                  };
                  await new Promise<void>((resolve) => {
                    if (signal.aborted) resolve();
                    else
                      signal.addEventListener(
                        'abort',
                        () => {
                          resolve();
                        },
                        { once: true },
                      );
                  });
                } finally {
                  producerClosed = true;
                }
              },
            }),
          },
        },
      };
      applicationFixture.application = await createTestApiApplication(config, {
        ...dependencies(),
        identityRuntime: selectedIdentityRuntime,
        workflowRuntime: selectedWorkflowRuntime,
      });
      await applicationFixture.application.listen(0, '127.0.0.1');
      const address = applicationFixture.application
        .getHttpServer()
        .address() as {
        port: number;
      };
      const responseStarted = Promise.withResolvers<undefined>();
      const client = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        path: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/runs/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/events',
        headers: { cookie: `pertexo_session=${'x'.repeat(40)}` },
      });
      const startTimer = setTimeout(() => {
        responseStarted.reject(new Error('SSE response did not start'));
      }, 1_000);
      const rejectStart = (error: Error) => {
        responseStarted.reject(error);
      };
      client.once('error', rejectStart);
      client.on('response', (response) => {
        response.once('data', () => {
          responseStarted.resolve(undefined);
        });
        response.once('error', rejectStart);
        response.once('end', () => {
          responseStarted.reject(
            new Error('SSE response ended before a frame'),
          );
        });
        response.resume();
      });
      client.end();
      try {
        await responseStarted.promise.finally(() => {
          clearTimeout(startTimer);
        });
        const drainState = applicationFixture.application.get(ApiDrainState);
        let closeTimer: NodeJS.Timeout | undefined;
        const closeDeadline = new Promise<never>((_resolve, reject) => {
          closeTimer = setTimeout(() => {
            reject(new Error('SSE application close timed out'));
          }, 1_000);
        });

        await Promise.race([
          applicationFixture.application.close(),
          closeDeadline,
        ]).finally(() => {
          if (closeTimer !== undefined) clearTimeout(closeTimer);
        });
        applicationFixture.application = undefined;

        expect(producerClosed).toBe(true);
        expect(drainState.activeStreamCount()).toBe(0);
        expect(selectedWorkflowRuntime.close).toHaveBeenCalledOnce();
      } finally {
        clearTimeout(startTimer);
        client.destroy();
      }
    });
  });
  it('enters drain state before shutdown resources close', async () => {
    const lifecycle: { drainState?: ApiDrainState } = {};
    const close = vi.fn().mockImplementation(() => {
      expect(lifecycle.drainState?.isDraining()).toBe(true);
      return Promise.resolve();
    });
    const selectedDatabase: WorkspaceDatabase = { ...database, close };
    const selectedApplication = await createTestApiApplication(
      config,
      dependencies(selectedDatabase),
    );
    lifecycle.drainState = selectedApplication.get(ApiDrainState);
    applicationFixture.application = selectedApplication;
    await applicationFixture.application.close();
    applicationFixture.application = undefined;

    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    ['first', ['telemetry']],
    ['middle', ['workflow']],
    ['last', ['database']],
    ['multiple', ['telemetry', 'identity', 'database']],
  ] as const)(
    'attempts every resource and releases signal listeners when the %s closer fails',
    async (_position, failingLabels) => {
      const baselineSignalListeners = process.listenerCount('SIGTERM');
      const events: string[] = [];
      const failures = new Map<string, Error>(
        failingLabels.map((label) => [
          label,
          new Error(`${label} close failed`),
        ]),
      );
      const lifecycle: {
        application?: Awaited<ReturnType<typeof createTestApiApplication>>;
        drain?: ApiDrainState;
      } = {};
      const closeOwner = (label: string) =>
        vi.fn((): Promise<void> => {
          expect(lifecycle.drain?.isDraining()).toBe(true);
          expect(lifecycle.application?.getHttpServer().listening).toBe(false);
          events.push(label);
          const failure = failures.get(label);
          if (failure !== undefined) return Promise.reject(failure);
          return Promise.resolve();
        });
      const databaseClose = closeOwner('database');
      const identityClose = closeOwner('identity');
      const workflowClose = closeOwner('workflow');
      const telemetryClose = closeOwner('telemetry');
      const selectedDatabase: WorkspaceDatabase = {
        ...database,
        close: databaseClose,
      };
      const selectedIdentity = identityRuntime(identityClose);
      const selectedWorkflow = createStubApiWorkflowRuntime(
        selectedIdentity.dependencies.authorization,
        workflowClose,
      );
      const selectedTelemetry: TelemetryLifecycle = {
        enabled: true,
        started: true,
        start: vi.fn(),
        shutdown: telemetryClose,
      };
      applicationFixture.application = await createTestApiApplication(config, {
        ...dependencies(selectedDatabase, selectedTelemetry),
        identityRuntime: selectedIdentity,
        workflowRuntime: selectedWorkflow,
      });
      lifecycle.application = applicationFixture.application;
      lifecycle.drain = applicationFixture.application.get(ApiDrainState);
      await applicationFixture.application.listen({
        host: '127.0.0.1',
        port: 0,
      });

      const result = await applicationFixture.application
        .close()
        .catch((error: unknown) => error);
      applicationFixture.application = undefined;

      expect(result).toBeInstanceOf(AggregateError);
      expect((result as AggregateError).errors).toEqual(
        events.flatMap((label) => {
          const failure = failures.get(label);
          return failure === undefined ? [] : [failure];
        }),
      );
      expect(events).toEqual(['telemetry', 'workflow', 'identity', 'database']);
      expect(databaseClose).toHaveBeenCalledOnce();
      expect(identityClose).toHaveBeenCalledOnce();
      expect(workflowClose).toHaveBeenCalledOnce();
      expect(telemetryClose).toHaveBeenCalledOnce();
      expect(process.listenerCount('SIGTERM')).toBe(baselineSignalListeners);
    },
  );

  it('shuts telemetry down with the Nest application lifecycle', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const selectedTelemetry: TelemetryLifecycle = {
      enabled: true,
      started: true,
      start: vi.fn(),
      shutdown,
    };
    applicationFixture.application = await createTestApiApplication(
      config,
      dependencies(database, selectedTelemetry),
    );
    await applicationFixture.application.init();
    await applicationFixture.application.close();
    applicationFixture.application = undefined;

    expect(shutdown).toHaveBeenCalledOnce();
  });

  describe('feature composition', () => {
    it('registers an injected identity runtime and owns its close lifecycle', async () => {
      const close = vi.fn().mockResolvedValue(undefined);
      const selectedIdentityRuntime = identityRuntime(close, true);
      applicationFixture.application = await createTestApiApplication(config, {
        ...dependencies(),
        identityRuntime: selectedIdentityRuntime,
      });
      await applicationFixture.application.init();

      const response = await applicationFixture.application.inject({
        method: 'GET',
        url: '/v1/users/me',
        headers: { cookie: 'pertexo_session=session' },
      });
      expect(response.statusCode).toBe(200);

      await applicationFixture.application.close();
      applicationFixture.application = undefined;
      expect(close).toHaveBeenCalledOnce();
    });

    it('keeps a composed protected route up when the limiter is unavailable', async () => {
      const selectedIdentityRuntime = identityRuntime(undefined, true);
      applicationFixture.application = await createTestApiApplication(config, {
        ...dependencies(),
        identityRuntime: selectedIdentityRuntime,
        rateLimitConsumer: {
          consume: () =>
            Promise.reject(new Error('redis endpoint unavailable')),
        },
      });

      const response = await applicationFixture.application.inject({
        method: 'GET',
        url: '/v1/invitation-acceptance',
        headers: { cookie: 'pertexo_session=session' },
      });

      expect(response.statusCode).not.toBe(503);
      expect(response.payload).not.toContain('redis endpoint unavailable');
      expect(
        // eslint-disable-next-line @typescript-eslint/unbound-method
        selectedIdentityRuntime.dependencies.sessions.authenticate,
      ).toHaveBeenCalled();
    });

    it.each([false, true])(
      'registers all discovery routes with authentication=%s',
      async (authenticated) => {
        applicationFixture.application = await createTestApiApplication(
          config,
          {
            ...dependencies(),
            identityRuntime: identityRuntime(undefined, authenticated),
          },
        );
        await applicationFixture.application.init();

        const routes = [
          '/v1/users/me',
          '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/members',
          '/v1/node-definitions',
          '/v1/integrations',
        ];
        for (const url of routes) {
          const response = await applicationFixture.application.inject({
            method: 'GET',
            url,
            ...(authenticated
              ? { headers: { cookie: `pertexo_session=${'s'.repeat(43)}` } }
              : {}),
          });
          expect(response.statusCode, url).toBe(authenticated ? 200 : 401);
        }
      },
    );

    it('enforces the member-role mutation HTTP boundary', async () => {
      const changeWorkspaceMemberRole = vi.fn().mockResolvedValue({
        userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        role: 'operator' as const,
        roleRevision: 2,
        changed: true,
        replayed: false,
      });
      applicationFixture.application = await createTestApiApplication(config, {
        ...dependencies(),
        identityRuntime: identityRuntime(
          vi.fn().mockResolvedValue(undefined),
          true,
          changeWorkspaceMemberRole,
        ),
      });
      await applicationFixture.application.init();
      const url =
        '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/members/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/role';
      const cookie = `pertexo_session=${'s'.repeat(43)}`;
      const csrf = 'c'.repeat(32);
      const missingCsrf = await applicationFixture.application.inject({
        method: 'POST',
        url,
        headers: { cookie, 'idempotency-key': 'member-role' },
        payload: { role: 'operator', expectedRoleRevision: 1 },
      });
      expect(missingCsrf.statusCode).toBe(403);
      const invalid = await applicationFixture.application.inject({
        method: 'POST',
        url,
        headers: {
          cookie: `${cookie}; pertexo_csrf=${csrf}`,
          'x-csrf-token': csrf,
          'idempotency-key': 'member-role',
        },
        payload: { role: 'operator', expectedRoleRevision: 1, extra: true },
      });
      expect(invalid.statusCode).toBe(400);
      const changed = await applicationFixture.application.inject({
        method: 'POST',
        url,
        headers: {
          cookie: `${cookie}; pertexo_csrf=${csrf}`,
          'x-csrf-token': csrf,
          'idempotency-key': 'member-role',
        },
        payload: { role: 'operator', expectedRoleRevision: 1 },
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toMatchObject({
        role: 'operator',
        roleRevision: 2,
      });
      expect(changeWorkspaceMemberRole).toHaveBeenCalledOnce();
    });

    it('lists every integration', async () => {
      applicationFixture.application = await createTestApiApplication(config, {
        ...dependencies(),
        identityRuntime: identityRuntime(undefined, true),
      });
      await applicationFixture.application.init();

      const response = await applicationFixture.application.inject({
        method: 'GET',
        url: '/v1/integrations',
        headers: { cookie: `pertexo_session=${'s'.repeat(43)}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        items: [
          {
            providerKey: 'email',
            operationKey: 'send_notification',
          },
          {
            providerKey: 'http',
            operationKey: 'request',
          },
          {
            providerKey: 'slack',
            operationKey: 'send_message',
          },
        ],
      });
    });

    it('rejects unsupported catalog query fields with problem details', async () => {
      applicationFixture.application = await createTestApiApplication(config, {
        ...dependencies(),
        identityRuntime: identityRuntime(undefined, true),
      });
      await applicationFixture.application.init();
      for (const route of ['node-definitions', 'integrations']) {
        const response = await applicationFixture.application.inject({
          method: 'GET',
          url: `/v1/${route}?arbitrary=value`,
          headers: { cookie: `pertexo_session=${'s'.repeat(43)}` },
        });
        expect(response.statusCode).toBe(400);
        expect(response.headers['content-type']).toContain(
          'application/problem+json',
        );
        expect(response.json()).toMatchObject({ code: 'request.invalid' });
      }
    });

    it('maps a user removed after authentication to safe profile problem details', async () => {
      const selectedIdentityRuntime = identityRuntime(undefined, true);
      applicationFixture.application = await createTestApiApplication(config, {
        ...dependencies(),
        identityRuntime: {
          ...selectedIdentityRuntime,
          dependencies: {
            ...selectedIdentityRuntime.dependencies,
            persistence: {
              ...selectedIdentityRuntime.dependencies.persistence,
              findUserById: () => Promise.resolve(null),
            },
          },
        },
      });
      await applicationFixture.application.init();

      const response = await applicationFixture.application.inject({
        method: 'GET',
        url: '/v1/users/me',
        headers: { cookie: `pertexo_session=${'s'.repeat(43)}` },
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(response.json()).toMatchObject({ code: 'auth.unauthenticated' });
    });

    it('serves checked-snapshot ETag and admission 503 through real HTTP guards without bypassing session CSRF', async () => {
      const selectedIdentity = identityRuntime(
        vi.fn().mockResolvedValue(undefined),
        true,
      );
      const baseRuntime = createStubApiWorkflowRuntime(
        selectedIdentity.dependencies.authorization,
      );
      const graph = EMPTY_WORKFLOW_GRAPH;
      const compatibility = workflowCompatibilityReport(
        graph,
        EMPTY_DEFINITION_CATALOG,
      );
      const draft = {
        workflowId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        revision: 11,
        graphJson: graph,
        compatibility,
        updatedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        updatedAt: new Date(),
      };
      const validateDraft = vi.fn().mockResolvedValue({
        currentPublication: null,
        draft,
        validation: {
          ok: true,
          issues: [],
          expandedInvocations: 0,
          worstCaseLoopIterations: 0,
        },
      });
      applicationFixture.application = await createTestApiApplication(config, {
        ...dependencies(),
        identityRuntime: selectedIdentity,
        workflowRuntime: {
          ...baseRuntime,
          dependencies: {
            ...baseRuntime.dependencies,
            persistence: {
              ...baseRuntime.dependencies.persistence,
              validateDraft,
            },
          },
        },
      });
      const url = `/v1/workspaces/${draft.workspaceId}/workflows/${draft.workflowId}/validate`;
      const cookie = `pertexo_session=${'s'.repeat(43)}`;
      const denied = await applicationFixture.application.inject({
        method: 'POST',
        url,
        headers: { cookie },
        payload: {},
      });
      expect(denied.statusCode).toBe(403);
      expect(validateDraft).not.toHaveBeenCalled();
      const csrf = 'c'.repeat(32);
      const headers = {
        cookie: `${cookie}; pertexo_csrf=${csrf}`,
        'x-csrf-token': csrf,
      };
      const checked = await applicationFixture.application.inject({
        method: 'POST',
        url,
        headers,
        payload: {},
      });
      expect(checked.statusCode).toBe(200);
      expect(checked.headers.etag).toBe(
        createDraftRepresentationTag({
          workflowId: draft.workflowId,
          revision: draft.revision,
          graph,
          compatibilityFingerprint: compatibility.fingerprint,
        }),
      );
      expect(checked.json()).toMatchObject({
        valid: true,
        currentPublication: null,
        issues: [],
        compatibility,
      });
      validateDraft.mockRejectedValue(
        new AuthoringValidationUnavailableError('overloaded'),
      );
      const unavailable = await applicationFixture.application.inject({
        method: 'POST',
        url,
        headers,
        payload: {},
      });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.headers['retry-after']).toBe('1');
      expect(unavailable.json()).toMatchObject({
        code: 'workflow.validation_unavailable',
        status: 503,
      });
      expect(validateDraft).toHaveBeenCalledWith(
        draft.workspaceId,
        draft.workflowId,
        draft.updatedBy,
        expect.anything(),
      );
      expect(validateDraft.mock.calls[0]?.[3]).toHaveProperty(
        'signal',
        expect.any(AbortSignal),
      );
    });

    it('registers workflow routes and closes identity and workflow runtimes together', async () => {
      const identityClose = vi.fn().mockResolvedValue(undefined);
      const workflowClose = vi.fn().mockResolvedValue(undefined);
      const selectedIdentityRuntime = identityRuntime(identityClose);
      applicationFixture.application = await createTestApiApplication(config, {
        ...dependencies(),
        identityRuntime: selectedIdentityRuntime,
        workflowRuntime: createStubApiWorkflowRuntime(
          selectedIdentityRuntime.dependencies.authorization,
          workflowClose,
        ),
      });
      await applicationFixture.application.init();

      const response = await applicationFixture.application.inject({
        method: 'GET',
        url: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflows',
      });
      expect(response.statusCode).toBe(401);

      const runResponse = await applicationFixture.application.inject({
        method: 'GET',
        url: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/runs/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      });
      expect(runResponse.statusCode).toBe(401);

      await applicationFixture.application.close();
      applicationFixture.application = undefined;
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
          checkpointFactory: () => ({ checkpoint: {} }),
        },
        close: webhookClose,
      } as unknown as ApiWebhookRuntime;
      applicationFixture.application = await createTestApiApplication(config, {
        ...dependencies(),
        identityRuntime: selectedIdentityRuntime,
        webhookRuntime,
      });

      const response = await applicationFixture.application.inject({
        method: 'POST',
        url: `/hooks/${'a'.repeat(43)}`,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(response.statusCode).toBe(401);
      expect(response.json<{ code: string }>().code).toBe(
        'webhook.authentication_failed',
      );

      const management = await applicationFixture.application.inject({
        method: 'GET',
        url: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflows/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/triggers',
      });
      expect(management.statusCode).toBe(401);

      await applicationFixture.application.close();
      applicationFixture.application = undefined;
      expect(webhookClose).toHaveBeenCalledOnce();
    });

    it.each([
      ['provision', 'provision', undefined],
      ['provision', 'provision', 'first,second'],
      ['rotate-endpoint', 'rotateEndpoint', undefined],
      ['rotate-endpoint', 'rotateEndpoint', 'first,second'],
      ['rotate-secret', 'rotateSecret', undefined],
      ['rotate-secret', 'rotateSecret', 'first,second'],
    ] as const)(
      'keeps supplied webhook %s (%s key %s) behind actual fixture session, CSRF, key and tenant guards',
      async (operation, method, rejectedKey) => {
        const owner = new FixtureResourceOwner();
        const close = vi.fn().mockResolvedValue(undefined);
        const provision = vi.fn().mockResolvedValue({
          trigger: {
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            workflowId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            workflowVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            nodeId: 'signed-input',
            kind: 'webhook',
            status: 'active',
            healthStatus: 'healthy',
            lastErrorCode: null,
            endpointReady: true,
            authentication: { mode: 'signed', allowedOrigins: [] },
            reconciledAt: null,
          },
          replayed: true,
        });
        const runtime = {
          service: {
            [method]: provision,
          } as unknown as WebhookManagementService,
          ingress: {
            database: { resolveVerification: vi.fn().mockResolvedValue(null) },
            encryption: {},
            checkpointFactory: () => ({
              checkpoint: {},
            }),
          },
          close,
        } as unknown as ApiWebhookRuntime;
        const csrf = 'c'.repeat(32);
        const cookie = `pertexo_session=${'s'.repeat(43)}; pertexo_csrf=${csrf}`;
        const path = `/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflows/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/triggers/cccccccc-cccc-4ccc-8ccc-cccccccccccc/webhook/${operation}`;
        const payload =
          operation === 'rotate-secret' ? { endpointKey: 'a'.repeat(43) } : {};
        try {
          applicationFixture.application =
            await createBetterAuthFixtureApplication({
              config: config,
              dependencies: {
                ...dependencies(),
                identityRuntime: identityRuntime(undefined, true),
                webhookRuntime: runtime,
              },
              owner: owner,
            });
          const validHeaders = {
            cookie,
            'x-csrf-token': csrf,
            'idempotency-key': 'owned-provision',
          };
          for (const [url, headers, status] of [
            [path, {}, 401],
            [path, { cookie, 'idempotency-key': 'owned-provision' }, 403],
            [
              path.replace(
                'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              ),
              validHeaders,
              404,
            ],
          ] as const) {
            const response = await applicationFixture.application.inject({
              method: 'POST',
              url,
              headers,
              payload,
            });
            expect(response.statusCode).toBe(status);
            expect(provision).not.toHaveBeenCalled();
          }
          const rejected = await applicationFixture.application.inject({
            method: 'POST',
            url: path,
            headers: {
              cookie,
              'x-csrf-token': csrf,
              ...(rejectedKey === undefined
                ? {}
                : { 'idempotency-key': rejectedKey }),
            },
            payload,
          });
          expect(rejected.statusCode).toBe(400);
          expect(rejected.json()).toMatchObject({
            code: 'request.invalid',
            status: 400,
          });
          expect(provision).not.toHaveBeenCalled();
          if (operation !== 'rotate-secret') {
            // api-design-18: a body naming settings used to be ignored, and a signed
            // endpoint came back for a caller who asked for a secret URL.
            const unaskedFor = await applicationFixture.application.inject({
              method: 'POST',
              url: path,
              headers: validHeaders,
              payload: { authentication: { mode: 'secret_url' } },
            });
            expect(unaskedFor.statusCode).toBe(400);
            expect(unaskedFor.json()).toMatchObject({
              code: 'request.invalid',
            });
            expect(provision).not.toHaveBeenCalled();
          }
          const accepted = await applicationFixture.application.inject({
            method: 'POST',
            url: path,
            headers: validHeaders,
            payload,
          });
          expect(accepted.statusCode).toBe(200);
          expect(provision).toHaveBeenCalledOnce();
          expect(provision).toHaveBeenCalledWith(
            expect.objectContaining({
              actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              triggerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              idempotencyKey: 'owned-provision',
            }),
          );
          provision.mockRejectedValueOnce(
            new Error('Unexpected service failure'),
          );
          const unexpected = await applicationFixture.application.inject({
            method: 'POST',
            url: path,
            headers: validHeaders,
            payload,
          });
          expect(unexpected.statusCode).toBe(500);
          expect(provision).toHaveBeenCalledTimes(2);
        } finally {
          await owner.close();
          applicationFixture.application = undefined;
        }
        expect(close).toHaveBeenCalledOnce();
      },
    );

    it('registers requested schedule preview in the actual Better Auth fixture composition', async () => {
      const owner = new FixtureResourceOwner();
      const previewFireTimes = vi.fn().mockResolvedValue({
        observedAt: new Date('2026-08-25T12:00:00.000Z'),
        items: [new Date('2026-08-25T12:01:00.000Z')],
      });
      const scheduleDatabase = {
        list: vi.fn().mockResolvedValue([]),
        setEnabled: vi.fn().mockRejectedValue(new Error('unused')),
        listOccurrences: vi.fn().mockResolvedValue({ items: [] }),
        nextFireTimes: vi.fn().mockRejectedValue(new Error('unused')),
        previewFireTimes,
        checkReadiness: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const csrf = 'c'.repeat(32);
      const cookie = `pertexo_session=${'s'.repeat(43)}; pertexo_csrf=${csrf}`;
      const path =
        '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflows/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/triggers/schedules/preview';
      let suppliedRuntime: ApiScheduleRuntime | undefined;
      try {
        applicationFixture.application =
          await createBetterAuthFixtureApplication({
            config: config,
            dependencies: {
              ...dependencies(),
              identityRuntime: identityRuntime(undefined, true),
            },
            owner: owner,
            schedules: true,
            createSchedules: () => {
              suppliedRuntime = {
                service: new ScheduleManagementService(
                  scheduleDatabase,
                  NOOP_SCHEDULE_TELEMETRY,
                ),
                checkReadiness: async () => {
                  await scheduleDatabase.checkReadiness();
                },
                close: vi.fn(async () => {
                  await scheduleDatabase.close();
                }),
              };
              return Promise.resolve(suppliedRuntime);
            },
          });
        const preview = await applicationFixture.application.inject({
          method: 'POST',
          url: path,
          headers: { cookie, 'x-csrf-token': csrf },
          payload: {
            config: { kind: 'interval', intervalMinutes: 1 },
            count: 1,
          },
        });
        expect(preview.statusCode).toBe(200);
        expect(preview.json()).toEqual({
          observedAt: '2026-08-25T12:00:00.000Z',
          items: [{ scheduledAt: '2026-08-25T12:01:00.000Z' }],
        });
        expect(previewFireTimes).toHaveBeenCalledOnce();
        expect(scheduleDatabase.checkReadiness).toHaveBeenCalled();
        const noSession = await applicationFixture.application.inject({
          method: 'POST',
          url: path,
          payload: { config: { kind: 'interval', intervalMinutes: 1 } },
        });
        expect(noSession.statusCode).toBe(401);
        const noCsrf = await applicationFixture.application.inject({
          method: 'POST',
          url: path,
          headers: { cookie },
          payload: { config: { kind: 'interval', intervalMinutes: 1 } },
        });
        expect(noCsrf.statusCode).toBe(403);
        const invalid = await applicationFixture.application.inject({
          method: 'POST',
          url: path,
          headers: { cookie, 'x-csrf-token': csrf },
          payload: { config: { kind: 'interval', intervalMinutes: 0 } },
        });
        expect(invalid.statusCode).toBe(400);
        expect(previewFireTimes).toHaveBeenCalledOnce();
        const denied = await applicationFixture.application.inject({
          method: 'POST',
          url: path.replace(
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          ),
          headers: { cookie, 'x-csrf-token': csrf },
          payload: { config: { kind: 'interval', intervalMinutes: 1 } },
        });
        expect(denied.statusCode).toBe(404);
        expect(previewFireTimes).toHaveBeenCalledOnce();
        previewFireTimes.mockRejectedValueOnce(
          new Error('private database failure'),
        );
        const unavailable = await applicationFixture.application.inject({
          method: 'POST',
          url: path,
          headers: { cookie, 'x-csrf-token': csrf },
          payload: { config: { kind: 'interval', intervalMinutes: 1 } },
        });
        expect(unavailable.statusCode).toBe(500);
      } finally {
        await owner.close();
        applicationFixture.application = undefined;
      }
      expect(scheduleDatabase.close).toHaveBeenCalledOnce();
      expect(suppliedRuntime?.close).toHaveBeenCalledOnce();
    });

    it('keeps schedule composition off for existing Better Auth fixtures by default', async () => {
      const owner = new FixtureResourceOwner();
      const createSchedules = vi.fn(createApiScheduleRuntime);
      try {
        applicationFixture.application =
          await createBetterAuthFixtureApplication({
            config: config,
            dependencies: {
              ...dependencies(),
              identityRuntime: identityRuntime(undefined, true),
            },
            owner: owner,
            schedules: undefined,
            createSchedules: createSchedules,
          });
        const response = await applicationFixture.application.inject({
          method: 'GET',
          url: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflows/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/triggers/schedules',
        });
        expect(response.statusCode).toBe(404);
        expect(createSchedules).not.toHaveBeenCalled();
      } finally {
        await owner.close();
        applicationFixture.application = undefined;
      }
    });

    it('retains fixture ownership when schedule readiness fails before application construction', async () => {
      const owner = new FixtureResourceOwner();
      const close = vi.fn().mockResolvedValue(undefined);
      const runtime: ApiScheduleRuntime = {
        service: {} as ScheduleManagementService,
        checkReadiness: () =>
          Promise.reject(new Error('schedule readiness unavailable')),
        close,
      };
      await expect(
        createBetterAuthFixtureApplication({
          config: config,
          dependencies: {
            ...dependencies(),
            identityRuntime: identityRuntime(undefined, true),
          },
          owner: owner,
          schedules: true,
          createSchedules: () => Promise.resolve(runtime),
        }),
      ).rejects.toThrow('schedule readiness unavailable');
      await owner.close();
      expect(close).toHaveBeenCalledOnce();
    });

    it('serves the workspace inbox through a supplied notification runtime and owns its readiness and close', async () => {
      const inboxDatabase = {
        listThreads: vi.fn(),
        readSummary: vi
          .fn()
          .mockResolvedValue({ unreadCount: 2, revision: '11' }),
        markThreadRead: vi.fn(),
        markAllRead: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const hints = {
        checkReadiness: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const notificationRuntime: ApiNotificationRuntime = {
        service: new WorkspaceInboxService(inboxDatabase),
        hints,
        checkReadiness: hints.checkReadiness,
        close: vi.fn().mockResolvedValue(undefined),
      };
      applicationFixture.application = await createTestApiApplication(config, {
        ...dependencies(),
        identityRuntime: identityRuntime(
          vi.fn().mockResolvedValue(undefined),
          true,
        ),
        notificationRuntime,
      });
      expect(hints.checkReadiness).toHaveBeenCalled();
      const summary =
        '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/notifications/summary';
      const cookie = `pertexo_session=${'s'.repeat(43)}`;
      expect(
        (
          await applicationFixture.application.inject({
            method: 'GET',
            url: summary,
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await applicationFixture.application.inject({
            method: 'GET',
            url: summary.replace(
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            ),
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(404);
      const read = await applicationFixture.application.inject({
        method: 'GET',
        url: summary,
        headers: { cookie },
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual({ unreadCount: 2, revision: '11' });

      await applicationFixture.application.close();
      applicationFixture.application = undefined;
      expect(notificationRuntime.close).toHaveBeenCalledOnce();
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
        listOccurrences: vi.fn().mockResolvedValue({
          items: [
            {
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              scheduledAt: '2026-08-25T12:00:00.000000Z',
              recordedAt: '2026-08-25T12:00:00.250000Z',
              outcome: 'skipped',
              runId: null,
            },
          ],
        }),
        nextFireTimes: vi.fn().mockResolvedValue({
          observedAt: new Date('2026-08-25T12:01:00.000Z'),
          items: [record.nextFireAt],
        }),
        previewFireTimes: vi.fn().mockResolvedValue({
          observedAt: new Date('2026-08-25T12:01:00.000Z'),
          items: [new Date('2026-08-25T12:16:00.000Z')],
        }),
        checkReadiness: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const scheduleRuntime = {
        service: new ScheduleManagementService(scheduleDatabase),
        checkReadiness: scheduleDatabase.checkReadiness,
        close: scheduleDatabase.close,
      } as ApiScheduleRuntime;
      applicationFixture.application = await createTestApiApplication(config, {
        ...dependencies(),
        identityRuntime: selectedIdentityRuntime,
        scheduleRuntime,
      });
      const base =
        '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflows/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/triggers';
      const unauthenticated = await applicationFixture.application.inject({
        method: 'GET',
        url: `${base}/schedules`,
      });
      expect(unauthenticated.statusCode).toBe(401);

      const cookie = `pertexo_session=${'s'.repeat(43)}`;
      const hidden = await applicationFixture.application.inject({
        method: 'GET',
        url: `${base.replace('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')}/schedules`,
        headers: { cookie },
      });
      expect(hidden.statusCode).toBe(404);

      const listed = await applicationFixture.application.inject({
        method: 'GET',
        url: `${base}/schedules`,
        headers: { cookie },
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toMatchObject({ items: [{ kind: 'schedule' }] });

      const missingCsrf = await applicationFixture.application.inject({
        method: 'POST',
        url: `${base}/${record.id}/schedule/disable`,
        headers: { cookie, 'idempotency-key': 'disable' },
        payload: {},
      });
      expect(missingCsrf.statusCode).toBe(403);

      const csrf = 'c'.repeat(32);
      const missingKey = await applicationFixture.application.inject({
        method: 'POST',
        url: `${base}/${record.id}/schedule/disable`,
        headers: {
          cookie: `${cookie}; pertexo_csrf=${csrf}`,
          'x-csrf-token': csrf,
        },
        payload: {},
      });
      expect(missingKey.statusCode).toBe(400);

      const disabled = await applicationFixture.application.inject({
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

      const history = await applicationFixture.application.inject({
        method: 'GET',
        url: `${base}/${record.id}/schedule/occurrences?limit=5`,
        headers: { cookie },
      });
      expect(history.statusCode).toBe(200);
      expect(history.json()).toEqual({
        items: [expect.objectContaining({ outcome: 'skipped', runId: null })],
        nextCursor: null,
      });
      const nextRuns = await applicationFixture.application.inject({
        method: 'GET',
        url: `${base}/${record.id}/schedule/next-runs`,
        headers: { cookie },
      });
      expect(nextRuns.json()).toEqual({
        observedAt: '2026-08-25T12:01:00.000Z',
        items: [{ scheduledAt: '2026-08-25T12:05:00.000Z' }],
      });
      expect(scheduleDatabase.nextFireTimes).toHaveBeenCalledWith(
        expect.objectContaining({ triggerId: record.id, count: 3 }),
      );
      const tooMany = await applicationFixture.application.inject({
        method: 'GET',
        url: `${base}/${record.id}/schedule/next-runs?count=11`,
        headers: { cookie },
      });
      expect(tooMany.statusCode).toBe(400);

      const preview = {
        config: { kind: 'interval', intervalMinutes: 15 },
        count: 1,
      };
      const unverifiedPreview = await applicationFixture.application.inject({
        method: 'POST',
        url: `${base}/schedules/preview`,
        headers: { cookie },
        payload: preview,
      });
      expect(unverifiedPreview.statusCode).toBe(403);
      const previewHeaders = {
        cookie: `${cookie}; pertexo_csrf=${csrf}`,
        'x-csrf-token': csrf,
      };
      const invalidPreview = await applicationFixture.application.inject({
        method: 'POST',
        url: `${base}/schedules/preview`,
        headers: previewHeaders,
        payload: { config: { kind: 'interval', intervalMinutes: 0 } },
      });
      expect(invalidPreview.statusCode).toBe(400);
      const previewed = await applicationFixture.application.inject({
        method: 'POST',
        url: `${base}/schedules/preview`,
        headers: previewHeaders,
        payload: preview,
      });
      expect(previewed.statusCode).toBe(200);
      expect(previewed.json()).toEqual({
        observedAt: '2026-08-25T12:01:00.000Z',
        items: [{ scheduledAt: '2026-08-25T12:16:00.000Z' }],
      });
      expect(scheduleDatabase.previewFireTimes).toHaveBeenCalledOnce();

      await applicationFixture.application.close();
      applicationFixture.application = undefined;
      expect(scheduleDatabase.close).toHaveBeenCalledOnce();
    });

    it('registers node-testing routes and providers from the workflow runtime', async () => {
      const selectedIdentityRuntime = identityRuntime();
      applicationFixture.application = await createTestApiApplication(config, {
        ...dependencies(),
        identityRuntime: selectedIdentityRuntime,
        workflowRuntime: nodeTestingWorkflowRuntime(
          selectedIdentityRuntime.dependencies.authorization,
          workflowAuthoringDatabase(),
        ),
      });
      await applicationFixture.application.init();

      expect(
        applicationFixture.application.get(TestWorkflowNodeUseCase),
      ).toBeInstanceOf(TestWorkflowNodeUseCase);
      expect(
        applicationFixture.application.get(GetPreviewRunUseCase),
      ).toBeInstanceOf(GetPreviewRunUseCase);

      const testResponse = await applicationFixture.application.inject({
        method: 'POST',
        url: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflows/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/draft/nodes/cccccccc-cccc-4ccc-8ccc-cccccccccccc/test',
        payload: { mode: 'validate' },
      });
      expect(testResponse.statusCode).toBe(401);

      const previewResponse = await applicationFixture.application.inject({
        method: 'GET',
        url: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/previews/dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      });
      expect(previewResponse.statusCode).toBe(401);
    });

    it('rejects deeply nested authenticated node-test JSON before preview reservation', async () => {
      const selectedIdentityRuntime = identityRuntime(
        vi.fn().mockResolvedValue(undefined),
        true,
      );
      const getDraft = vi.fn().mockRejectedValue(new Error('not used'));
      const acceptPreview = vi.fn().mockRejectedValue(new Error('not used'));
      applicationFixture.application = await createTestApiApplication(config, {
        ...dependencies(),
        identityRuntime: selectedIdentityRuntime,
        workflowRuntime: nodeTestingWorkflowRuntime(
          selectedIdentityRuntime.dependencies.authorization,
          { ...workflowAuthoringDatabase(), getDraft, acceptPreview },
        ),
      });
      const csrf = 'c'.repeat(32);
      const payload = `{"mode":"validate","expectedRevision":1,"sampleInput":${'['.repeat(10_000)}null${']'.repeat(10_000)}}`;
      const response = await applicationFixture.application.inject({
        method: 'POST',
        url: '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflows/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/draft/nodes/cccccccc-cccc-4ccc-8ccc-cccccccccccc/test',
        headers: {
          cookie: `pertexo_session=${'s'.repeat(43)}; pertexo_csrf=${csrf}`,
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'request.invalid' });
      expect(getDraft).not.toHaveBeenCalled();
      expect(acceptPreview).not.toHaveBeenCalled();
    });

    it('mounts Better Auth on the public web origin', async () => {
      const selected = betterAuthIdentityRuntime();
      applicationFixture.application = await createTestApiApplication(
        {
          ...config,
          identity: betterAuthIdentityConfig('https://app.example.test'),
        },
        { ...dependencies(), identityRuntime: selected.runtime },
      );
      await applicationFixture.application.init();

      const capabilities = await applicationFixture.application.inject({
        method: 'GET',
        url: '/v1/auth/capabilities',
      });
      expect(capabilities.json()).toEqual({
        password: {
          enabled: true,
          minimumLength: 12,
          verificationRequired: true,
        },
        socialProviders: ['google'],
        signUp: 'open',
      });
      const crossOrigin = await applicationFixture.application.inject({
        method: 'POST',
        url: '/v1/auth/sign-in/email',
        headers: { origin: 'https://api.example.test' },
        payload: {},
      });
      expect(crossOrigin.statusCode).toBe(403);
      const accepted = await applicationFixture.application.inject({
        method: 'POST',
        url: '/v1/auth/sign-in/email',
        headers: { origin: 'https://app.example.test' },
        payload: {},
      });
      expect(accepted.statusCode).toBe(200);
      expect(selected.requests).toEqual([
        'POST https://app.example.test/v1/auth/sign-in/email',
      ]);
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
        createTestApiApplication(config, {
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
        createTestApiApplication(config, {
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
      applicationFixture.application = await createTestApiApplication(config, {
        ...dependencies(),
        identityRuntime: identityRuntime(),
        artifactRuntime: selectedArtifacts,
      });
      expect(selectedArtifacts.checkReadiness).toHaveBeenCalledOnce();
      vi.mocked(selectedArtifacts.checkReadiness).mockRejectedValue(
        new Error('private bucket detail'),
      );
      const response = await applicationFixture.application.inject({
        method: 'GET',
        url: '/health/ready',
      });
      expect(response.statusCode).toBe(503);
      expect(response.payload).not.toContain('private bucket detail');
      await applicationFixture.application.close();
      applicationFixture.application = undefined;
      expect(selectedArtifacts.close).toHaveBeenCalledOnce();
    });
  });
});
