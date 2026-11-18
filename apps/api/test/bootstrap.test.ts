import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanAPIBootstrapOwnershipHealthFixture,
  config,
  dependencies,
  applicationFixture,
  database,
  identityRuntime,
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

// Only what a real stack can't produce on demand stays here: a dependency
// failing at startup or close, readiness failing after startup, and drain
// racing a pending check or an open stream. Everything else this file used
// to check runs on the real stack (production-composition and the area
// integration tests).
describe('API bootstrap ownership and health', () => {
  afterEach(cleanAPIBootstrapOwnershipHealthFixture);

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

  describe('startup failure ownership', () => {
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
