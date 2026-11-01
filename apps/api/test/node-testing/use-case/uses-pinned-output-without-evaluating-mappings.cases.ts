import { randomUUID } from 'node:crypto';

import type { ExpressionEvaluator } from '@pertexo/workflow-model/server';

import { WorkflowNotFoundError } from '@pertexo/core/testing';
import { expect, it, vi } from 'vitest';

import { TestWorkflowNodeUseCase } from '../../../src/node-testing/use-case.js';
import { authorizeWorkspace } from '../../../src/authorization/index.js';

import {
  workspaceId,
  acceptedAt,
  expiresAt,
  actor,
  graph,
  graphWithConfig,
  draft,
  accepted,
  persistence,
  authorization,
  requestInput,
} from './fixture.js';

export function registerUsesPinnedOutputWithoutEvaluatingMappings(): void {
  it('uses pinned output without evaluating mappings or authorizing credentials, while setup validation stays real', async () => {
    const store = persistence({
      getDraft: vi
        .fn()
        .mockResolvedValue(draft({ graphJson: graphWithConfig({}) })),
    });
    const sampleId = randomUUID();
    vi.spyOn(store.stepSamples, 'get').mockResolvedValue({
      sample: {
        id: sampleId,
        nodeId: 'http',
        binding: 'server-checked',
        state: 'pinned',
        source: { kind: 'json' },
        createdAt: acceptedAt,
        expiresAt,
      },
      output: { kind: 'inline', value: { example: true } },
      draftRevision: 3,
    });
    vi.spyOn(store, 'acceptPreview').mockResolvedValue({
      ...accepted(),
      status: 'succeeded',
      outboxEventId: null,
      previewAttemptId: null,
      pinnedSampleId: sampleId,
      pinnedOutput: { kind: 'inline', value: { example: true } },
      completedAt: acceptedAt,
    });
    const access = authorization();
    const evaluate = vi
      .fn()
      .mockRejectedValue(new Error('Unused mapping must not execute'));
    const useCase = new TestWorkflowNodeUseCase(
      store,
      access,
      () => acceptedAt,
      { evaluate },
    );
    const response = await useCase.execute({
      ...requestInput(),
      idempotencyKey: randomUUID(),
      request: {
        mode: 'test_execute',
        expectedRevision: 3,
        expectedSampleId: sampleId,
        acknowledgeSideEffects: true,
        input: { kind: 'manual', value: {} },
      },
    });
    expect(response).toMatchObject({
      mode: 'test_execute',
      preview: {
        status: 'succeeded',
        pinnedSampleId: sampleId,
        startedAt: null,
        output: { kind: 'inline', value: { example: true } },
        disclosure: {
          mayContactProvider: false,
          mayCauseExternalSideEffect: false,
        },
      },
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(access.findAccess).toHaveBeenCalledTimes(1);
    await expect(
      useCase.execute({
        ...requestInput(),
        request: { mode: 'validate', expectedRevision: 3, sampleInput: {} },
      }),
    ).resolves.toMatchObject({ valid: false });
    await expect(
      useCase.execute({
        ...requestInput(),
        idempotencyKey: randomUUID(),
        request: {
          mode: 'test_execute',
          expectedRevision: 3,
          expectedSampleId: null,
          acknowledgeSideEffects: true,
          input: { kind: 'manual', value: {} },
        },
      }),
    ).rejects.toMatchObject({ reason: 'changed' });
    expect(store.acceptPreview).toHaveBeenCalledOnce();
  });

  it('uses the composition-owned evaluator for expression mappings', async () => {
    const evaluate = vi.fn().mockResolvedValue({
      kind: 'value',
      value: { encoding: 'utf8', value: 'evaluated' },
      canonicalBytes: 39,
    });
    const evaluator: ExpressionEvaluator = {
      evaluate,
    };
    const store = persistence({
      getDraft: vi.fn().mockResolvedValue(
        draft({
          graphJson: {
            ...graph(),
            nodes: [
              {
                ...graph().nodes[0],
                inputMappings: {
                  body: {
                    kind: 'expression',
                    language: 'jsonata',
                    expression: 'runInput.body',
                  },
                },
              },
            ],
          },
        }),
      ),
    });
    const useCase = new TestWorkflowNodeUseCase(
      store,
      authorization(),
      undefined,
      evaluator,
    );

    await expect(
      useCase.execute({
        ...requestInput(),
        request: {
          mode: 'validate',
          expectedRevision: 3,
          sampleInput: { body: 'source' },
        },
      }),
    ).resolves.toMatchObject({ valid: true, issues: [] });
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ expression: 'runInput.body' }),
    );
  });

  it('returns pure bounded validation and never accepts execution', async () => {
    const store = persistence();
    const access = authorization();
    const authorizedWorkspace = await authorizeWorkspace({
      actor,
      routeWorkspaceId: workspaceId,
      capability: 'workflow:update',
      access,
      disclosure: 'not_found',
    });
    const useCase = new TestWorkflowNodeUseCase(store, access);
    await expect(
      useCase.execute({
        ...requestInput(),
        authorizedWorkspace,
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
    // One guard lookup plus the distinct connection:use check; the duplicate
    // workflow:update use-case lookup is gone.
    expect(access.findAccess).toHaveBeenCalledTimes(2);
  });

  it('maps a missing visible draft before node preparation', async () => {
    const store = persistence({
      getDraft: vi.fn().mockResolvedValue(null),
    });
    const useCase = new TestWorkflowNodeUseCase(store, authorization());

    await expect(
      useCase.execute({
        ...requestInput(),
        request: { mode: 'validate', expectedRevision: 3 },
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    expect(store.acceptPreview).not.toHaveBeenCalled();
  });

  it('reports the exact current revision representation after draft mutation', async () => {
    const store = persistence({
      getDraft: vi.fn().mockResolvedValue(draft({ revision: 4 })),
    });
    const useCase = new TestWorkflowNodeUseCase(store, authorization());

    await expect(
      useCase.execute({
        ...requestInput(),
        request: { mode: 'validate', expectedRevision: 3 },
      }),
    ).rejects.toMatchObject({
      name: 'WorkflowRevisionConflictError',
      currentRevision: 4,
      currentEtag: '"draft.8TzCes2UynZ5w_QC7b_vUnsZkX8j-vonJu1MhXrf27o"',
    });
  });
}
