import { describe, expect, it, vi } from 'vitest';
import { PreviewIdempotencyConflictError } from '@pertexo/core/testing';
import { TestWorkflowNodeService } from '../../src/node-testing/node-testing.service.js';
import {
  workspaceId,
  persistence,
  authorization,
  requestInput,
  actorId,
} from './node-testing-service.fixture.js';

/**
 * The flows live in step-test-admission.integration.test.ts. These cases
 * stay because no real stack reaches them: every role that may edit a
 * workflow may also use its connections, so the separate connection check
 * only fails if access changes between the two lookups; and a second request
 * can only win the key between this request's replay read and its admission
 * by an exact race.
 */
const builderThenViewer = () => {
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
  return access;
};

const execute = {
  mode: 'test_execute',
  expectedRevision: 3,
  acknowledgeSideEffects: true,
  input: {
    kind: 'manual',
    value: { body: { encoding: 'utf8', value: 'hello' } },
  },
} as const;

describe('node test connection and admission races', () => {
  it.each([
    [
      'validation',
      {
        mode: 'validate',
        expectedRevision: 3,
        sampleInput: { body: { encoding: 'utf8', value: 'hello' } },
      },
    ],
    ['execution', execute],
  ] as const)(
    'denies %s when the referenced connection is no longer usable',
    async (_name, request) => {
      const store = persistence();
      const service = new TestWorkflowNodeService(store, builderThenViewer());

      await expect(
        service.execute({
          ...requestInput(),
          idempotencyKey: 'preview-denied-connection-use',
          request,
        }),
      ).rejects.toMatchObject({
        name: 'AuthorizationError',
        code: 'resource.not_found',
      });
      expect(store.acceptPreview).not.toHaveBeenCalled();
    },
  );

  it('maps an atomic-admission idempotency conflict after a replay miss', async () => {
    const store = persistence({
      acceptPreview: vi
        .fn()
        .mockRejectedValue(new PreviewIdempotencyConflictError()),
    });
    const service = new TestWorkflowNodeService(store, authorization());

    await expect(
      service.execute({
        ...requestInput(),
        idempotencyKey: 'preview-raced-conflict',
        request: execute,
      }),
    ).rejects.toBeInstanceOf(PreviewIdempotencyConflictError);
  });
});
