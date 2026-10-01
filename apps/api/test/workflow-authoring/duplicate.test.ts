import { describe, expect, it, vi } from 'vitest';
import { DuplicateWorkflowUseCase } from '../../src/workflow-authoring/duplicate-use-case.js';
import {
  authorizeWorkspace,
  createActorContext,
} from '../../src/workspaces/index.js';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workflowId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const destinationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const actorId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const versionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const tag = `"draft-v1.${'a'.repeat(43)}"`;
function fixture(role: 'owner' | 'builder' | 'operator' | 'viewer' = 'owner') {
  const duplicateWorkflow = vi
    .fn()
    .mockResolvedValue({ workflowId: destinationId });
  const access = {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role,
      membershipStatus: 'active',
      workspaceStatus: 'active',
    }),
  };
  return {
    duplicateWorkflow,
    access,
    useCase: new DuplicateWorkflowUseCase({ duplicateWorkflow }, access),
  };
}
const input = {
  actor: createActorContext({
    actorId,
    workspaceId,
    sessionId: versionId,
    requestId: 'request-copy',
    traceId: 'trace-copy',
  }),
  routeWorkspaceId: workspaceId,
  workflowId,
  request: { name: '  Copy  ', source: { kind: 'draft' } },
  representationTag: tag,
  idempotencyKey: 'copy-key',
};

describe('workflow duplication application seam', () => {
  it.each(['workflow:read', 'workflow:create'] as const)(
    'reuses only the matching %s guard proof and freshly authorizes the other capability',
    async (capability) => {
      const { useCase, duplicateWorkflow, access } = fixture();
      const authorizedWorkspace = await authorizeWorkspace({
        actor: input.actor,
        routeWorkspaceId: workspaceId,
        capability,
        access,
        disclosure: 'not_found',
      });
      access.findAccess.mockClear();
      await expect(
        useCase.execute({ ...input, authorizedWorkspace }),
      ).resolves.toEqual({ workflowId: destinationId });
      expect(access.findAccess).toHaveBeenCalledTimes(1);
      expect(duplicateWorkflow).toHaveBeenCalledTimes(1);
    },
  );
  it('normalizes only the name and forwards exact selector/tag/key and cancellation to the atomic command', async () => {
    const { useCase, duplicateWorkflow } = fixture('builder');
    const signal = new AbortController().signal;
    await expect(useCase.execute({ ...input, signal })).resolves.toEqual({
      workflowId: destinationId,
    });
    expect(duplicateWorkflow).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      workflowId,
      actorId,
      name: 'Copy',
      source: { kind: 'draft' },
      representationTag: tag,
      idempotencyKey: 'copy-key',
      requestId: 'request-copy',
      traceId: 'trace-copy',
      signal,
    });
  });

  it('selects the immutable version explicitly without substituting or sending a draft tag', async () => {
    const { useCase, duplicateWorkflow } = fixture();
    await useCase.execute({
      ...input,
      request: { name: 'Version copy', source: { kind: 'version', versionId } },
    });
    expect(duplicateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'version', versionId } }),
    );
    expect(duplicateWorkflow.mock.calls[0]?.[0]).not.toHaveProperty(
      'representationTag',
    );
  });

  it('handles a version command without optional trace, signal or precondition context', async () => {
    const { useCase, duplicateWorkflow } = fixture();
    const actor = createActorContext({
      actorId,
      workspaceId,
      sessionId: versionId,
      requestId: 'copy-no-trace',
    });
    await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      request: {
        name: 'Minimal version copy',
        source: { kind: 'version', versionId },
      },
      idempotencyKey: 'minimal-copy',
    });
    expect(duplicateWorkflow).toHaveBeenCalledExactlyOnceWith({
      actorId,
      workspaceId,
      workflowId,
      name: 'Minimal version copy',
      source: { kind: 'version', versionId },
      idempotencyKey: 'minimal-copy',
      requestId: 'copy-no-trace',
    });
  });

  it('requires destination creation authority even when the actor can read the source', async () => {
    for (const role of ['viewer', 'operator'] as const) {
      const { useCase, duplicateWorkflow } = fixture(role);
      await expect(useCase.execute(input)).rejects.toThrow();
      expect(duplicateWorkflow).not.toHaveBeenCalled();
    }
  });

  it('rejects missing/malformed draft tags and client graph/source overrides before persistence', async () => {
    const { useCase, duplicateWorkflow } = fixture();
    for (const representationTag of [undefined, '*', 'W/"tag"']) {
      const { representationTag: _tag, ...withoutTag } = input;
      await expect(
        useCase.execute({
          ...withoutTag,
          ...(representationTag === undefined ? {} : { representationTag }),
        }),
      ).rejects.toThrow();
    }
    for (const request of [
      { ...input.request, graph: {} },
      { name: 'Copy', source: { kind: 'draft', versionId } },
      { name: 'Copy', source: { kind: 'version' } },
      { name: 'Copy', source: { kind: 'version', versionId, graph: {} } },
    ])
      await expect(useCase.execute({ ...input, request })).rejects.toThrow();
    expect(duplicateWorkflow).not.toHaveBeenCalled();
  });

  it('fails closed on a malformed or over-disclosing persistence result', async () => {
    const { useCase, duplicateWorkflow } = fixture();
    duplicateWorkflow.mockResolvedValue({
      workflowId: destinationId,
      graph: {},
    });
    await expect(useCase.execute(input)).rejects.toThrow();
  });

  it('does not start persistence after the request has been cancelled', async () => {
    const { useCase, duplicateWorkflow } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      useCase.execute({ ...input, signal: controller.signal }),
    ).rejects.toThrow();
    expect(duplicateWorkflow).not.toHaveBeenCalled();
  });
});
