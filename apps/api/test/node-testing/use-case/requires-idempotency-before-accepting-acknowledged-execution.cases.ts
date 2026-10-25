import { PreviewIdempotencyConflictError } from '@pertexo/database/testing';
import { expect, it, vi } from 'vitest';

import { TestWorkflowNodeUseCase } from '../../../src/node-testing/use-case.js';

import { nodeTestingPreview } from '../fixture.js';
import {
  workspaceId,
  workflowId,
  acceptedAt,
  expiresAt,
  graph,
  draft,
  persistence,
  authorization,
  requestInput,
} from './fixture.js';

export function registerRequiresIdempotencyBeforeAcceptingAcknowledgedExecution(): void {
  it('requires idempotency before accepting acknowledged execution', async () => {
    const useCase = new TestWorkflowNodeUseCase(persistence(), authorization());
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
    ).rejects.toMatchObject({
      code: 'idempotency_required',
      name: 'NodeTestRequestError',
    });
  });

  it('rejects incompatible config identity before preview acceptance', async () => {
    const store = persistence({
      getDraft: vi.fn().mockResolvedValue(
        draft({
          graphJson: {
            ...graph(),
            nodes: [{ ...graph().nodes[0], configVersion: 2 }],
          },
        }),
      ),
    });
    const useCase = new TestWorkflowNodeUseCase(store, authorization());

    await expect(
      useCase.execute({
        ...requestInput(),
        idempotencyKey: 'preview-config-mismatch',
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
      name: 'NodeTestInvalidError',
      issues: [
        {
          path: '$.configVersion',
          code: 'node.config_version_incompatible',
          message: 'Selected node configuration version is incompatible',
        },
      ],
    });
    expect(store.acceptPreview).not.toHaveBeenCalled();
  });

  it('returns the retained preview before reading a mutated draft', async () => {
    const retained = nodeTestingPreview({ status: 'succeeded' });
    const store = persistence({
      getDraft: vi.fn().mockResolvedValue(draft({ revision: 4 })),
      resolvePreviewReplay: vi.fn().mockResolvedValue(retained),
    });
    const access = authorization();
    const useCase = new TestWorkflowNodeUseCase(store, access);

    await expect(
      useCase.execute({
        ...requestInput(),
        idempotencyKey: 'preview-replay',
        request: {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: { kind: 'manual', value: { original: true } },
        },
      }),
    ).resolves.toEqual({
      mode: 'test_execute',
      replayed: true,
      preview: {
        id: retained.id,
        workspaceId,
        workflowId,
        draftRevision: 3,
        nodeId: 'http',
        status: 'succeeded',
        disclosure: {
          sideEffectClass: 'unsafe',
          mayContactProvider: true,
          mayCauseExternalSideEffect: true,
          dryRun: 'not_supported',
        },
        output: null,
        safeErrorCode: null,
        createdAt: acceptedAt.toISOString(),
        startedAt: null,
        completedAt: null,
        expiresAt: expiresAt.toISOString(),
      },
    });
    expect(store.getDraft).not.toHaveBeenCalled();
    expect(store.acceptPreview).not.toHaveBeenCalled();
    expect(access.findAccess).toHaveBeenCalledOnce();
  });

  it('maps changed content under the same replay key before reading the draft', async () => {
    const store = persistence({
      resolvePreviewReplay: vi
        .fn()
        .mockRejectedValue(new PreviewIdempotencyConflictError()),
    });
    const useCase = new TestWorkflowNodeUseCase(store, authorization());

    await expect(
      useCase.execute({
        ...requestInput(),
        idempotencyKey: 'preview-conflict',
        request: {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: { kind: 'manual', value: { changed: true } },
        },
      }),
    ).rejects.toBeInstanceOf(PreviewIdempotencyConflictError);
    expect(store.getDraft).not.toHaveBeenCalled();
    expect(store.acceptPreview).not.toHaveBeenCalled();
  });

  it('maps an atomic-admission idempotency conflict after a replay miss', async () => {
    const store = persistence({
      acceptPreview: vi
        .fn()
        .mockRejectedValue(new PreviewIdempotencyConflictError()),
    });
    const useCase = new TestWorkflowNodeUseCase(store, authorization());

    await expect(
      useCase.execute({
        ...requestInput(),
        idempotencyKey: 'preview-raced-conflict',
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
    ).rejects.toBeInstanceOf(PreviewIdempotencyConflictError);
    expect(store.resolvePreviewReplay).toHaveBeenCalledOnce();
    expect(store.acceptPreview).toHaveBeenCalledOnce();
  });

  it('still rejects a stale revision when a new key has no replay', async () => {
    const store = persistence({
      getDraft: vi.fn().mockResolvedValue(draft({ revision: 4 })),
    });
    const useCase = new TestWorkflowNodeUseCase(store, authorization());

    await expect(
      useCase.execute({
        ...requestInput(),
        idempotencyKey: 'preview-new-key',
        request: {
          mode: 'test_execute',
          expectedRevision: 3,
          acknowledgeSideEffects: true,
          input: { kind: 'manual', value: {} },
        },
      }),
    ).rejects.toMatchObject({
      name: 'WorkflowRevisionConflictError',
      currentRevision: 4,
    });
    expect(store.resolvePreviewReplay).toHaveBeenCalledOnce();
    expect(store.acceptPreview).not.toHaveBeenCalled();
  });
}
