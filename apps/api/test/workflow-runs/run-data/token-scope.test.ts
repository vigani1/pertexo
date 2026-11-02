import type { ApiTokenScope } from '@pertexo/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  AuthorizationError,
  createAutomationActorContext,
} from '../../../src/authorization/index.js';
import { GetWorkflowRunInputUseCase } from '../../../src/workflow-runs/run-data/use-cases.js';

const actorId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';

function read(scopes: readonly ApiTokenScope[]) {
  const readInput = vi
    .fn()
    .mockResolvedValue({ kind: 'inline', value: { order: 'A-17' } });
  const useCase = new GetWorkflowRunInputUseCase(
    { readInput },
    {
      findAccess: vi.fn().mockResolvedValue({
        actorId,
        workspaceId,
        role: 'viewer',
        membershipStatus: 'active',
        workspaceStatus: 'active',
      }),
    },
  );
  return {
    readInput,
    result: useCase.execute({
      actor: createAutomationActorContext({
        actorId,
        workspaceId,
        tokenId: '44444444-4444-4444-8444-444444444444',
        requestId: 'run-data-token',
        scopes,
      }),
      routeWorkspaceId: workspaceId,
      runId,
    }),
  };
}

describe('what an API token can read of a run', () => {
  it('reads its input with run:read-data', async () => {
    await expect(read(['run:read-data']).result).resolves.toMatchObject({
      input: { kind: 'inline', value: { order: 'A-17' } },
    });
  });

  it('does not read it with run:read alone, and reaches no data', async () => {
    const { readInput, result } = read(['run:read']);
    await expect(result).rejects.toBeInstanceOf(AuthorizationError);
    expect(readInput).not.toHaveBeenCalled();
  });
});
