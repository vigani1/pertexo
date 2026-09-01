import { randomUUID } from 'node:crypto';

import { PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE } from '@pertexo/node-catalog';
import { composeExecutableCompatibilityRelease } from '@pertexo/workflow-engine';
import type {
  AcceptedPreviewRun,
  WorkflowDraftRecord,
} from '@pertexo/database/testing';
import { describe, expect, it, vi } from 'vitest';

import { NodeTestIdempotencyRequiredError } from '../../src/node-testing/errors.js';
import { TestWorkflowNodeUseCase } from '../../src/node-testing/use-case.js';
import { createActorContext } from '../../src/workspaces/index.js';
import type { NodeTestingPersistence } from '../../src/node-testing/ports.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const connectionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const acceptedAt = new Date('2026-08-22T20:00:00.000Z');
const expiresAt = new Date('2026-08-29T20:00:00.000Z');
const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  requestId: 'request-node-test',
});

function graph() {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: 'http',
        definition: { key: 'http.request', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {
          method: 'POST',
          url: 'https://provider.example.test/resource',
          headers: {},
          timeoutMillis: 1_000,
          maxRedirects: 1,
          maxResponseBytes: 1_024,
          inlineResponseBytes: 512,
        },
        inputMappings: {
          body: { kind: 'run_input', path: '$.body' },
        },
        connectionRefs: { http_headers: connectionId },
      },
    ],
    edges: [],
    settings: {},
  } as const;
}

function draft(
  overrides: Partial<WorkflowDraftRecord> = {},
): WorkflowDraftRecord {
  return {
    workflowId,
    workspaceId,
    revision: 3,
    schemaVersion: 1,
    graphJson: graph(),
    compatibility: {
      compatible: true,
      fingerprint: PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE.fingerprint,
      issues: [],
    },
    updatedBy: actorId,
    updatedAt: new Date('2026-08-22T19:00:00.000Z'),
    ...overrides,
  };
}

function accepted(): AcceptedPreviewRun {
  return {
    acceptedAt,
    duplicate: false,
    expiresAt,
    outboxEventId: randomUUID(),
    previewAttemptId: randomUUID(),
    previewRunId: randomUUID(),
    status: 'queued',
  };
}

type TestNodePersistence = Pick<
  NodeTestingPersistence,
  'acceptPreview' | 'getDraft'
>;

function persistence(overrides: Partial<TestNodePersistence> = {}) {
  return {
    getDraft: vi.fn().mockResolvedValue(draft()),
    acceptPreview: vi.fn().mockResolvedValue(accepted()),
    ...overrides,
  } satisfies TestNodePersistence;
}

function authorization() {
  return {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role: 'owner' as const,
      membershipStatus: 'active' as const,
      workspaceStatus: 'active' as const,
    }),
  };
}

function requestInput() {
  return {
    actor,
    routeWorkspaceId: workspaceId,
    workflowId,
    nodeId: 'http',
  } as const;
}

describe('node test application use case', () => {
  it('returns pure bounded validation and never accepts execution', async () => {
    const store = persistence();
    const access = authorization();
    const useCase = new TestWorkflowNodeUseCase(
      store,
      access,
      PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
    );
    await expect(
      useCase.execute({
        ...requestInput(),
        request: {
          mode: 'validate',
          expectedRevision: 3,
          sampleInput: {
            body: { encoding: 'utf8', value: 'hello' },
          },
        },
      }),
    ).resolves.toMatchObject({
      mode: 'validate',
      valid: true,
      revision: 3,
      nodeId: 'http',
      issues: [],
      disclosure: {
        sideEffectClass: 'unsafe',
        mayContactProvider: true,
        mayCauseExternalSideEffect: true,
      },
    });
    expect(store.acceptPreview).not.toHaveBeenCalled();
    expect(access.findAccess).toHaveBeenCalledTimes(2);
  });

  it('denies validation when a referenced connection is not authorized', async () => {
    const store = persistence();
    const access = authorization();
    access.findAccess
      .mockResolvedValueOnce({
        actorId,
        workspaceId,
        role: 'builder',
        membershipStatus: 'active',
        workspaceStatus: 'active',
      })
      .mockResolvedValueOnce({
        actorId,
        workspaceId,
        role: 'viewer',
        membershipStatus: 'active',
        workspaceStatus: 'active',
      });
    const useCase = new TestWorkflowNodeUseCase(
      store,
      access,
      PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
    );

    await expect(
      useCase.execute({
        ...requestInput(),
        request: {
          mode: 'validate',
          expectedRevision: 3,
          sampleInput: {
            body: { encoding: 'utf8', value: 'hello' },
          },
        },
      }),
    ).rejects.toMatchObject({
      name: 'AuthorizationError',
      code: 'resource.not_found',
    });
    expect(access.findAccess).toHaveBeenCalledTimes(2);
    expect(store.getDraft).toHaveBeenCalledOnce();
    expect(store.acceptPreview).not.toHaveBeenCalled();
  });

  it('denies execution before reading a draft without workflow update authority', async () => {
    const store = persistence();
    const access = authorization();
    access.findAccess.mockResolvedValue({
      actorId,
      workspaceId,
      role: 'operator',
      membershipStatus: 'active',
      workspaceStatus: 'active',
    });
    const useCase = new TestWorkflowNodeUseCase(
      store,
      access,
      PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
    );

    await expect(
      useCase.execute({
        ...requestInput(),
        idempotencyKey: 'preview-denied-workflow-update',
        request: {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: {
            kind: 'manual',
            value: { body: { encoding: 'utf8', value: 'hello' } },
          },
        },
      }),
    ).rejects.toMatchObject({
      name: 'AuthorizationError',
      code: 'resource.not_found',
    });
    expect(access.findAccess).toHaveBeenCalledOnce();
    expect(store.getDraft).not.toHaveBeenCalled();
    expect(store.acceptPreview).not.toHaveBeenCalled();
  });

  it('denies execution when a referenced connection is not authorized', async () => {
    const store = persistence();
    const access = authorization();
    access.findAccess
      .mockResolvedValueOnce({
        actorId,
        workspaceId,
        role: 'builder',
        membershipStatus: 'active',
        workspaceStatus: 'active',
      })
      .mockResolvedValueOnce({
        actorId,
        workspaceId,
        role: 'viewer',
        membershipStatus: 'active',
        workspaceStatus: 'active',
      });
    const useCase = new TestWorkflowNodeUseCase(
      store,
      access,
      PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
    );

    await expect(
      useCase.execute({
        ...requestInput(),
        idempotencyKey: 'preview-denied-connection-use',
        request: {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: {
            kind: 'manual',
            value: { body: { encoding: 'utf8', value: 'hello' } },
          },
        },
      }),
    ).rejects.toMatchObject({
      name: 'AuthorizationError',
      code: 'resource.not_found',
    });
    expect(access.findAccess).toHaveBeenCalledTimes(2);
    expect(store.getDraft).toHaveBeenCalledOnce();
    expect(store.acceptPreview).not.toHaveBeenCalled();
  });

  it('requires idempotency before accepting acknowledged execution', async () => {
    const useCase = new TestWorkflowNodeUseCase(
      persistence(),
      authorization(),
      PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
    );
    await expect(
      useCase.execute({
        ...requestInput(),
        request: {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: {
            kind: 'manual',
            value: { body: { encoding: 'utf8', value: 'hello' } },
          },
        },
      }),
    ).rejects.toBeInstanceOf(NodeTestIdempotencyRequiredError);
  });

  it('pins the exact release and accepts one identifier-only durable preview', async () => {
    const executionRelease = composeExecutableCompatibilityRelease(
      PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
    );
    const result = accepted();
    const store = persistence({
      acceptPreview: vi.fn().mockResolvedValue(result),
    });
    const access = authorization();
    const useCase = new TestWorkflowNodeUseCase(
      store,
      access,
      PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
      () => acceptedAt,
    );
    await expect(
      useCase.execute({
        ...requestInput(),
        idempotencyKey: 'preview-key-1',
        requestId: 'request-node-test',
        traceId: 'trace-node-test',
        request: {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: {
            kind: 'manual',
            value: { body: { encoding: 'utf8', value: 'hello' } },
          },
        },
      }),
    ).resolves.toMatchObject({
      mode: 'test_execute',
      replayed: false,
      preview: {
        id: result.previewRunId,
        status: 'queued',
        output: null,
      },
    });
    expect(store.acceptPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        workflowId,
        nodeId: 'http',
        definitionKey: 'http.request',
        executorKey: 'http.request',
        compatibilityReleaseEpoch: executionRelease.epoch,
        compatibilityReleaseFingerprint: executionRelease.fingerprint,
        sideEffectClass: 'unsafe',
        expiresAt,
        input: {
          kind: 'manual',
          value: { body: { encoding: 'utf8', value: 'hello' } },
        },
      }),
    );
    expect(access.findAccess).toHaveBeenCalledTimes(2);
  });

  it('defers prior-preview value resolution to the tenant transaction', async () => {
    const store = persistence();
    const useCase = new TestWorkflowNodeUseCase(
      store,
      authorization(),
      PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
      () => acceptedAt,
    );
    const priorPreviewRunId = randomUUID();
    await expect(
      useCase.execute({
        ...requestInput(),
        idempotencyKey: 'preview-key-2',
        request: {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: { kind: 'prior_preview', previewRunId: priorPreviewRunId },
        },
      }),
    ).resolves.toMatchObject({ mode: 'test_execute' });
    expect(store.acceptPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { kind: 'prior_preview', previewRunId: priorPreviewRunId },
      }),
    );
  });
});
