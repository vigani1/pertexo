import { expect, it, vi } from 'vitest';
import { NodeTestInvalidError } from '../../../src/node-testing/errors.js';
import { TestWorkflowNodeUseCase } from '../../../src/node-testing/use-case.js';

import {
  actorId,
  workspaceId,
  graph,
  graphWithConfig,
  draft,
  persistence,
  authorization,
  requestInput,
} from './fixture.js';

export function registerPreservesUnknownDraftReadFailureBy(): void {
  it('preserves an unknown draft-read failure by identity', async () => {
    const failure = new Error('draft store unavailable');
    const store = persistence({
      getDraft: vi.fn().mockRejectedValue(failure),
    });
    const useCase = new TestWorkflowNodeUseCase(store, authorization());

    await expect(
      useCase.execute({
        ...requestInput(),
        request: { mode: 'validate', expectedRevision: 3 },
      }),
    ).rejects.toBe(failure);
  });

  it.each(['http', 'validate'] as const)(
    'rejects malformed %s config before accepting preview execution',
    async (kind) => {
      const invalidGraph =
        kind === 'http'
          ? graphWithConfig({
              ...graph().nodes[0].config,
              timeoutMillis: 0,
            })
          : {
              ...graph(),
              nodes: [
                {
                  ...graph().nodes[0],
                  definition: { key: 'core.validate', version: 1 },
                  config: { rules: [{ id: 'bad', path: '$.*' }] },
                  inputMappings: {},
                  connectionRefs: {},
                },
              ],
            };
      const store = persistence({
        getDraft: vi.fn().mockResolvedValue(
          draft({
            graphJson: invalidGraph,
          }),
        ),
      });
      const useCase = new TestWorkflowNodeUseCase(store, authorization());

      const result = await useCase
        .execute({
          ...requestInput(),
          idempotencyKey: 'preview-invalid-config',
          request: {
            mode: 'test_execute',
            expectedRevision: 3,
            acknowledgeSideEffects: true,
            input: {
              kind: 'manual',
              value: { body: { encoding: 'utf8', value: 'hello' } },
            },
          },
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(result).toBeInstanceOf(NodeTestInvalidError);
      if (!(result instanceof NodeTestInvalidError)) return;
      expect(
        result.issues.some(
          ({ code, path }) =>
            code === 'node.config_invalid' &&
            path ===
              (kind === 'http'
                ? '$.config.timeoutMillis'
                : '$.config.rules[0].path'),
        ),
      ).toBe(true);
      expect(store.acceptPreview).not.toHaveBeenCalled();
    },
  );

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
    const useCase = new TestWorkflowNodeUseCase(store, access);

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
    const useCase = new TestWorkflowNodeUseCase(store, access);

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
    const useCase = new TestWorkflowNodeUseCase(store, access);

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
}
