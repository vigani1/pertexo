import { PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE } from '@pertexo/node-catalog';
import type { AcceptedPreviewRun } from '@pertexo/database/testing';
import { describe, expect, it, vi } from 'vitest';

import { NodeTestingController } from '../../src/node-testing/controller.js';
import { mapNodeTestingError } from '../../src/node-testing/errors.js';
import { APPLICATION_ERROR_CATALOG } from '../../src/platform/http/index.js';
import {
  GetPreviewRunUseCase,
  TestWorkflowNodeUseCase,
} from '../../src/node-testing/use-case.js';
import {
  nodeTestingAcceptedAt,
  nodeTestingDraft,
  nodeTestingIds,
  nodeTestingPreview,
} from './fixture.js';

const { actorId, workspaceId, workflowId } = nodeTestingIds;
const guardActorId = '99999999-9999-4999-8999-999999999999';
const previewRunId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const acceptedAt = nodeTestingAcceptedAt;
const expiresAt = new Date('2026-08-22T21:00:00.000Z');

const draft = nodeTestingDraft;

function controller() {
  const accepted: AcceptedPreviewRun = {
    acceptedAt,
    duplicate: false,
    expiresAt,
    outboxEventId: '11111111-1111-4111-8111-111111111111',
    previewAttemptId: '22222222-2222-4222-8222-222222222222',
    previewRunId,
    status: 'queued',
  };
  const persistence = {
    getDraft: vi.fn().mockResolvedValue(draft()),
    acceptPreview: vi.fn().mockResolvedValue(accepted),
    resolvePreviewReplay: vi.fn().mockResolvedValue(null),
    readPreview: vi
      .fn()
      .mockResolvedValue(nodeTestingPreview({ id: previewRunId, expiresAt })),
  };
  const authorization = {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role: 'owner' as const,
      membershipStatus: 'active' as const,
      workspaceStatus: 'active' as const,
    }),
  };
  return {
    controller: new NodeTestingController(
      new TestWorkflowNodeUseCase(
        persistence,
        authorization,
        PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
        () => acceptedAt,
      ),
      new GetPreviewRunUseCase(persistence, authorization),
    ),
    persistence,
  };
}

function request(headers: Record<string, string | readonly string[]> = {}) {
  return {
    headers,
    requestId: 'request-node-test',
    traceId: 'trace-node-test',
    identitySession: {
      userId: actorId,
      sessionId: '33333333-3333-4333-8333-333333333333',
      expiresAt: new Date('2026-08-23T00:00:00.000Z'),
      clientMetadata: {},
    },
  } as const;
}

const params = { workspaceId, workflowId, nodeId: 'http' };

describe('node testing controller', () => {
  it('projects absent and guarded workspace context through the owning controller', async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ mode: 'validate', valid: true });
    const instance = new NodeTestingController(
      { execute } as never,
      { execute: vi.fn() } as never,
    );
    const response = { status: vi.fn() };
    const command = { mode: 'validate' as const, expectedRevision: 3 };
    await instance.test(request(), params, command, response);
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest asymmetric matcher is intentionally untyped at this nested boundary.
        actor: expect.objectContaining({
          actorId,
          requestId: 'request-node-test',
          traceId: 'trace-node-test',
        }),
        requestId: 'request-node-test',
        traceId: 'trace-node-test',
      }),
    );
    expect(execute.mock.calls.at(-1)?.[0]).not.toHaveProperty(
      'authorizedWorkspace',
    );

    const base = request();
    const authorizedWorkspace = {
      actor: Object.freeze({
        actorId: guardActorId,
        kind: 'user' as const,
        workspaceId,
        sessionId: base.identitySession.sessionId,
        requestId: 'guard-request',
        traceId: 'guard-trace',
      }),
      workspaceId,
      role: 'owner' as const,
      capability: 'workflow:update' as const,
    };
    await instance.test(
      { ...base, authorizedWorkspace },
      params,
      command,
      response,
    );
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actor: authorizedWorkspace.actor,
        authorizedWorkspace,
        requestId: 'guard-request',
        traceId: 'guard-trace',
      }),
    );
  });

  it('maps an invalid session actor from the controller to request.invalid status 400', async () => {
    const execute = vi.fn();
    const instance = new NodeTestingController(
      { execute } as never,
      { execute: vi.fn() } as never,
    );
    let thrown: unknown;
    try {
      await instance.test(
        {
          ...request(),
          identitySession: {
            ...request().identitySession,
            userId: 'not-a-uuid',
          },
        },
        params,
        { mode: 'validate', expectedRevision: 3 },
        { status: vi.fn() },
      );
    } catch (error) {
      thrown = error;
    }
    expect(mapNodeTestingError(thrown)).toMatchObject({
      code: 'request.invalid',
    });
    expect(APPLICATION_ERROR_CATALOG['request.invalid'].status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps deeply nested authenticated input to request.invalid before preview work', async () => {
    const execute = vi.fn();
    const instance = new NodeTestingController(
      { execute } as never,
      { execute: vi.fn() } as never,
    );
    const authenticated = request({
      cookie: 'pertexo_session=session; pertexo_csrf=csrf-token',
      'x-csrf-token': 'csrf-token',
    });
    const authorizedWorkspace = {
      actor: {
        actorId,
        kind: 'user' as const,
        workspaceId,
        sessionId: authenticated.identitySession.sessionId,
        requestId: authenticated.requestId,
        traceId: authenticated.traceId,
      },
      workspaceId,
      role: 'owner' as const,
      capability: 'workflow:update' as const,
    };
    const sampleInput = JSON.parse(
      `${'['.repeat(10_000)}null${']'.repeat(10_000)}`,
    ) as unknown;

    let thrown: unknown;
    try {
      await instance.test(
        { ...authenticated, authorizedWorkspace },
        params,
        { mode: 'validate', expectedRevision: 3, sampleInput },
        { status: vi.fn() },
      );
    } catch (error) {
      thrown = error;
    }
    expect(mapNodeTestingError(thrown)).toMatchObject({
      code: 'request.invalid',
    });
    expect(APPLICATION_ERROR_CATALOG['request.invalid'].status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns validation at 200 without requiring or using idempotency', async () => {
    const fixture = controller();
    const response = { status: vi.fn() };
    await expect(
      fixture.controller.test(
        request({ 'Idempotency-Key': ['ignored', 'duplicate'] }),
        params,
        {
          mode: 'validate',
          expectedRevision: 3,
          sampleInput: {
            body: { encoding: 'utf8', value: 'hello' },
          },
        },
        response,
      ),
    ).resolves.toMatchObject({ mode: 'validate', valid: true });
    expect(response.status).not.toHaveBeenCalled();
    expect(fixture.persistence.acceptPreview).not.toHaveBeenCalled();
  });

  it('returns durable execution acceptance at 202', async () => {
    const fixture = controller();
    const response = { status: vi.fn() };
    await expect(
      fixture.controller.test(
        request({
          'Idempotency-Key': 'preview-key',
          traceparent:
            '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        }),
        params,
        {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: {
            kind: 'manual',
            value: { body: { encoding: 'utf8', value: 'hello' } },
          },
        },
        response,
      ),
    ).resolves.toMatchObject({
      mode: 'test_execute',
      preview: { id: previewRunId, status: 'queued' },
    });
    expect(response.status).toHaveBeenCalledWith(202);
    expect(fixture.persistence.acceptPreview).toHaveBeenCalledTimes(1);
    expect(fixture.persistence.acceptPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      }),
    );
  });

  it('maps missing execution idempotency to the stable precondition problem', async () => {
    const fixture = controller();
    await expect(
      fixture.controller.test(
        request(),
        params,
        {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: { kind: 'manual', value: {} },
        },
        { status: vi.fn() },
      ),
    ).rejects.toMatchObject({
      code: 'idempotency_required',
      name: 'NodeTestRequestError',
    });
    expect(fixture.persistence.acceptPreview).not.toHaveBeenCalled();
  });

  it.each([
    ['', 'empty'],
    ['contains space', 'malformed'],
    ['first,second', 'comma-folded'],
    [['first', 'second'], 'multiple'],
  ] as const)(
    'rejects %s execution idempotency as %s',
    async (value, label) => {
      void label;
      const fixture = controller();

      await expect(
        fixture.controller.test(
          request({ 'Idempotency-Key': value }),
          params,
          {
            mode: 'test_execute',
            expectedRevision: 3,
            acknowledgeSideEffects: true,
            input: { kind: 'manual', value: {} },
          },
          { status: vi.fn() },
        ),
      ).rejects.toMatchObject({ name: 'InvalidIdempotencyKeyError' });
      expect(fixture.persistence.resolvePreviewReplay).not.toHaveBeenCalled();
      expect(fixture.persistence.acceptPreview).not.toHaveBeenCalled();
    },
  );

  it('reads one scoped preview status without using production events', async () => {
    const fixture = controller();
    await expect(
      fixture.controller.status(request(), { workspaceId, previewRunId }),
    ).resolves.toMatchObject({
      preview: { id: previewRunId, status: 'queued', output: null },
    });
    expect(fixture.persistence.readPreview).toHaveBeenCalledWith({
      workspaceId,
      actorUserId: actorId,
      previewRunId,
    });
  });
});
