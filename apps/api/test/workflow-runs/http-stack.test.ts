import type { IdentityWorkspaceDependencies } from '../../src/identity-workspace/index.js';
import type { ApiIdentityRuntime } from '../../src/platform/identity/identity-runtime.module.js';
import type { WorkflowRunPersistence } from '../../src/workflow-runs/ports.js';
import {
  WorkflowRunIdempotencyConflictError,
  WorkflowRunNotCancelableError,
  WorkflowRunNotExecutableError,
} from '../../src/workflow-runs/errors.js';
import { WorkflowRunNotFoundError } from '../../src/workflow-runs/use-cases.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApiApplication } from '../../src/app.js';
import {
  createApiPlatformFixture,
  createStubApiWorkflowRuntime,
} from '../support/api-platform.fixture.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const runId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const workflowVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const rawSession = 's'.repeat(43);
const csrf = 'c'.repeat(32);

const { config, database, logger, rateLimitConsumer, telemetry } =
  createApiPlatformFixture('0021_workflow_integration_usage.sql');

function identityRuntime(
  role: 'builder' | 'owner' | 'viewer' = 'owner',
): ApiIdentityRuntime {
  const dependencies: IdentityWorkspaceDependencies = {
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
        Promise.resolve({
          sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          tokenDigest: 'a'.repeat(64),
          userId: actorId,
          expiresAt: new Date('2099-08-22T20:00:00.000Z'),
          clientMetadata: {},
        }),
      revokeByDigest: () => Promise.resolve(false),
      findUserById: () => Promise.resolve(null),
      listAccessibleWorkspaces: () => Promise.resolve({ items: [] }),
      listWorkspaceMembers: () => Promise.resolve({ items: [] }),
      changeWorkspaceMemberRole: () => Promise.reject(new Error('not used')),
      resolveOrCreateIdentity: () => Promise.resolve({ userId: actorId }),
      createWorkspaceWithOwner: () => Promise.reject(new Error('not used')),
      requestWorkspaceLifecycleOperation: () =>
        Promise.reject(new Error('not used')),
      readWorkspaceLifecycleOperation: () =>
        Promise.reject(new Error('not used')),
    },
    authorization: {
      findAccess: (query: Readonly<{ actorId: string; workspaceId: string }>) =>
        Promise.resolve(
          query.actorId === actorId && query.workspaceId === workspaceId
            ? {
                actorId,
                workspaceId,
                role,
                membershipStatus: 'active' as const,
                workspaceStatus: 'active' as const,
              }
            : undefined,
        ),
    },
  };
  return Object.freeze({ dependencies, close: () => Promise.resolve() });
}

function persistenceFixture() {
  const start = vi.fn<WorkflowRunPersistence['start']>();
  const replay = vi.fn<WorkflowRunPersistence['replay']>();
  const get = vi.fn<WorkflowRunPersistence['get']>();
  const list = vi.fn<WorkflowRunPersistence['list']>();
  const cancel = vi.fn<WorkflowRunPersistence['cancel']>();
  return {
    persistence: {
      start,
      replay,
      get,
      list,
      cancel,
    } satisfies WorkflowRunPersistence,
    start,
    replay,
    get,
    list,
    cancel,
  };
}

const authHeaders = {
  cookie: `pertexo_session=${rawSession}; pertexo_csrf=${csrf}`,
};
const mutationHeaders = {
  ...authHeaders,
  'x-csrf-token': csrf,
  'idempotency-key': 'workflow-run-http-stack',
};

describe('workflow runs real Nest HTTP stack', () => {
  let application: Awaited<ReturnType<typeof createApiApplication>> | undefined;

  async function start(role: 'builder' | 'owner' | 'viewer' = 'owner') {
    const identity = identityRuntime(role);
    const fixture = persistenceFixture();
    const baseRuntime = createStubApiWorkflowRuntime(
      identity.dependencies.authorization,
    );
    application = await createApiApplication(config, {
      database,
      identityRuntime: identity,
      workflowRuntime: {
        ...baseRuntime,
        runDependencies: {
          authorization: identity.dependencies.authorization,
          persistence: fixture.persistence,
          streamer: baseRuntime.runDependencies.streamer,
        },
      },
      logger,
      rateLimitConsumer,
      telemetry,
    });
    await application.init();
    return { application, fixture };
  }

  afterEach(async () => {
    await application?.close();
    application = undefined;
  });

  it('runs authentication and authorization guards before workflow persistence', async () => {
    const { application, fixture } = await start('viewer');

    const unauthenticated = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/runs/${runId}`,
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({
      status: 401,
      code: 'auth.unauthenticated',
    });
    expect(fixture.get).not.toHaveBeenCalled();

    const unauthenticatedList = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/runs`,
    });
    expect(unauthenticatedList.statusCode).toBe(401);
    expect(fixture.list).not.toHaveBeenCalled();

    const unauthorizedStart = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/workflows/${workflowId}/runs`,
      headers: mutationHeaders,
      payload: {},
    });
    expect(unauthorizedStart.statusCode).toBe(404);
    expect(unauthorizedStart.json()).toMatchObject({
      status: 404,
      code: 'resource.not_found',
    });
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it('lists safe run summaries and rejects unsupported filters', async () => {
    const { application, fixture } = await start('viewer');
    const createdAt = new Date('2026-08-21T12:00:00.000Z');
    fixture.list.mockResolvedValue({
      items: [
        {
          id: runId,
          workspaceId,
          workflowId,
          workflowVersionId,
          status: 'succeeded',
          triggerType: 'manual',
          createdAt,
          updatedAt: createdAt,
          startedAt: createdAt,
          completedAt: createdAt,
          deadlineAt: null,
          cancelRequestedAt: null,
        },
      ],
    });

    const response = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/runs?limit=25&workflowId=${workflowId}&status=succeeded`,
      headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [{ id: runId, status: 'succeeded' }],
      nextCursor: null,
    });
    expect(fixture.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25, workflowId, status: 'succeeded' }),
    );

    const invalid = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/runs?status=invalid`,
      headers: authHeaders,
    });
    expect(invalid.statusCode).toBe(400);
    expect(fixture.list).toHaveBeenCalledTimes(1);
  });

  it('maps workflow domain failures to exact public status and problem bodies', async () => {
    const { application, fixture } = await start();
    fixture.start.mockRejectedValueOnce(
      new WorkflowRunIdempotencyConflictError(),
    );
    fixture.replay.mockRejectedValueOnce(new WorkflowRunNotExecutableError());
    fixture.get.mockRejectedValueOnce(new WorkflowRunNotFoundError());
    fixture.cancel.mockRejectedValueOnce(new WorkflowRunNotCancelableError());

    const startResponse = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/workflows/${workflowId}/runs`,
      headers: mutationHeaders,
      payload: {},
    });
    expect(startResponse.statusCode).toBe(409);
    expect(startResponse.json()).toMatchObject({
      status: 409,
      code: 'request.idempotency_conflict',
    });

    const replayResponse = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/runs/${runId}/replay`,
      headers: { ...mutationHeaders, 'idempotency-key': 'replay-http-stack' },
      payload: { workflowVersionId, input: null },
    });
    expect(replayResponse.statusCode).toBe(409);
    expect(replayResponse.json()).toMatchObject({
      status: 409,
      code: 'workflow.not_published',
    });

    const getResponse = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/runs/${runId}`,
      headers: authHeaders,
    });
    expect(getResponse.statusCode).toBe(404);
    expect(getResponse.json()).toMatchObject({
      status: 404,
      code: 'resource.not_found',
    });

    const cancelResponse = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/runs/${runId}/cancel`,
      headers: { ...mutationHeaders, 'idempotency-key': 'cancel-http-stack' },
      payload: {},
    });
    expect(cancelResponse.statusCode).toBe(409);
    expect(cancelResponse.json()).toMatchObject({
      status: 409,
      code: 'run.not_cancelable',
    });
  });
});
