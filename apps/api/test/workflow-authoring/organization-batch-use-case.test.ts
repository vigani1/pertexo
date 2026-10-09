import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  WorkflowFolderConflictError,
  IdempotencyConflictError,
  WorkflowNotFoundError,
  WorkflowOrganizationUnavailableError,
  WorkflowTagConflictError,
  type WorkflowOrganizationBatchDatabase,
  type WorkflowOrganizationBatchInput,
  type WorkflowOrganizationBatchItemResult,
} from '@pertexo/database/api';
import {
  AuthorizationError,
  authorizeWorkspace,
  createActorContext,
  type WorkspaceAccess,
  type WorkspaceAuthorizationPort,
} from '../../src/workspaces/index.js';
import { WorkflowOrganizationBatchesUseCase } from '../../src/workflow-authoring/organization-batch-use-case.js';

const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const firstId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const secondId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const folderId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const tagId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId: folderId,
  requestId: 'organization-batch',
});
const base = {
  actor,
  routeWorkspaceId: workspaceId,
  idempotencyKey: 'frozen-parent-key',
};
const items = [
  { workflowId: firstId, expectedOrganizationRevision: 7 },
  { workflowId: secondId, expectedOrganizationRevision: 2 },
];
const move = { operation: 'move' as const, folderId, items };
const cleanup = { tagId, items };
const access = (role: WorkspaceAccess['role'] = 'owner'): WorkspaceAccess => ({
  actorId,
  workspaceId,
  role,
  membershipStatus: 'active',
  workspaceStatus: 'active',
});
const updated = (
  workflowId: string,
  organizationRevision = 8,
  replayed = false,
) => ({
  workflowId,
  status: 'updated' as const,
  organizationRevision,
  replayed,
});

function result(
  input: WorkflowOrganizationBatchInput & Readonly<{ workflowId: string }>,
): WorkflowOrganizationBatchItemResult {
  return {
    workflowId: input.workflowId,
    organizationRevision: 8,
    replayed: false,
    ...(input.request.operation === 'move'
      ? { folderId: input.request.folderId }
      : {}),
  };
}
function fixture(role: WorkspaceAccess['role'] = 'owner') {
  const batches = {
    admitBatch: vi
      .fn<WorkflowOrganizationBatchDatabase['admitBatch']>()
      .mockResolvedValue({ admitted: true }),
    executeBatchItem: vi
      .fn<WorkflowOrganizationBatchDatabase['executeBatchItem']>()
      .mockImplementation((input) => Promise.resolve(result(input))),
    close: vi.fn<WorkflowOrganizationBatchDatabase['close']>(),
  } satisfies WorkflowOrganizationBatchDatabase;
  const authorization = {
    findAccess: vi
      .fn<WorkspaceAuthorizationPort['findAccess']>()
      .mockResolvedValue(access(role)),
  };
  return {
    batches,
    authorization,
    useCase: new WorkflowOrganizationBatchesUseCase(batches, authorization),
  };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred was not initialized');
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('workflow organization full-parent batch orchestration', () => {
  it('normalizes the full parent without reordering selection and passes the same identity to admission and every item', async () => {
    const f = fixture('builder');
    const signal = new AbortController().signal;
    const request = Object.freeze({
      operation: 'replace_tags',
      tagIds: Object.freeze([tagId.toUpperCase(), secondId]),
      items: Object.freeze(
        items.map((item) =>
          Object.freeze({ ...item, workflowId: item.workflowId.toUpperCase() }),
        ),
      ),
    });
    const canonical = {
      operation: 'replace_tags',
      tagIds: [secondId, tagId],
      items,
    };
    expect(await f.useCase.bulk({ ...base, request, signal })).toEqual({
      items: items.map((item) => updated(item.workflowId)),
    });
    const parent = {
      workspaceId,
      actorId,
      idempotencyKey: base.idempotencyKey,
      request: canonical,
      signal,
    };
    expect(f.batches.admitBatch).toHaveBeenCalledExactlyOnceWith(parent);
    expect(
      f.batches.executeBatchItem.mock.calls.map(([input]) => input),
    ).toEqual(
      items.map((item) => ({ ...parent, workflowId: item.workflowId })),
    );
    expect(f.authorization.findAccess).toHaveBeenCalledTimes(3);
    for (const [input] of f.authorization.findAccess.mock.calls)
      expect(input).toEqual({ workspaceId, actorId, signal });
    expect(request.tagIds).toEqual([tagId.toUpperCase(), secondId]);
  });

  it('awaits separate parent admission before starting the first item and awaits each item before the next', async () => {
    const f = fixture();
    const admitted = deferred<Readonly<{ admitted: true }>>();
    const admissionStarted = deferred<undefined>();
    const firstStarted = deferred<undefined>();
    const firstCompleted = deferred<WorkflowOrganizationBatchItemResult>();
    f.batches.admitBatch.mockImplementationOnce(() => {
      admissionStarted.resolve(undefined);
      return admitted.promise;
    });
    f.batches.executeBatchItem.mockImplementationOnce(() => {
      firstStarted.resolve(undefined);
      return firstCompleted.promise;
    });
    const pending = f.useCase.bulk({ ...base, request: move });
    await admissionStarted.promise;
    expect(f.batches.executeBatchItem).not.toHaveBeenCalled();
    expect(f.authorization.findAccess).toHaveBeenCalledOnce();
    admitted.resolve({ admitted: true });
    await firstStarted.promise;
    expect(f.batches.executeBatchItem).toHaveBeenCalledOnce();
    expect(f.batches.executeBatchItem.mock.calls[0]?.[0].workflowId).toBe(
      firstId,
    );
    firstCompleted.resolve({
      workflowId: firstId,
      folderId,
      organizationRevision: 8,
      replayed: false,
    });
    expect(await pending).toEqual({
      items: [updated(firstId), updated(secondId)],
    });
    expect(
      f.batches.executeBatchItem.mock.calls.map(([input]) => input.workflowId),
    ).toEqual([firstId, secondId]);
  });

  it.each([
    new IdempotencyConflictError(),
    new WorkflowOrganizationUnavailableError(),
    new Error('admission transport outcome unknown'),
  ])(
    'does not attempt an item or retry after parent admission rejects: %s',
    async (error) => {
      const f = fixture();
      f.batches.admitBatch.mockRejectedValueOnce(error);
      await expect(f.useCase.bulk({ ...base, request: move })).rejects.toBe(
        error,
      );
      expect(f.batches.admitBatch).toHaveBeenCalledOnce();
      expect(f.batches.executeBatchItem).not.toHaveBeenCalled();
      expect(f.authorization.findAccess).toHaveBeenCalledOnce();
    },
  );

  it('returns serial partial outcomes in submitted order, sanitizes errors and does not reattempt known items', async () => {
    const f = fixture();
    const ids = Array.from(
      { length: 8 },
      (_, index) =>
        `${String(index + 1).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    );
    f.batches.executeBatchItem
      .mockImplementationOnce((input) =>
        Promise.resolve({ ...result(input), replayed: true }),
      )
      .mockRejectedValueOnce(new WorkflowNotFoundError())
      .mockRejectedValueOnce(
        new WorkflowTagConflictError('organization_revision'),
      )
      .mockRejectedValueOnce(new IdempotencyConflictError())
      .mockRejectedValueOnce(new WorkflowTagConflictError('lifecycle'))
      .mockRejectedValueOnce(new WorkflowFolderConflictError('not_visible'))
      .mockRejectedValueOnce(new WorkflowOrganizationUnavailableError())
      .mockRejectedValueOnce(
        new Error(`private actor=${actorId}, retained revision=999`),
      );
    const request = {
      ...move,
      items: ids.map((workflowId) => ({
        workflowId,
        expectedOrganizationRevision: 1,
      })),
    };
    expect(await f.useCase.bulk({ ...base, request })).toEqual({
      items: [
        updated(ids[0] ?? '', 8, true),
        { workflowId: ids[1], status: 'not_visible' },
        {
          workflowId: ids[2],
          status: 'conflict',
          code: 'workflow.organization_revision_conflict',
        },
        {
          workflowId: ids[3],
          status: 'conflict',
          code: 'request.idempotency_conflict',
        },
        {
          workflowId: ids[4],
          status: 'conflict',
          code: 'workflow.lifecycle_conflict',
        },
        {
          workflowId: ids[5],
          status: 'conflict',
          code: 'workflow.folder_not_visible',
        },
        {
          workflowId: ids[6],
          status: 'unavailable',
          code: 'workflow.organization_unavailable',
        },
        { workflowId: ids[7], status: 'outcome_unknown' },
      ],
    });
    expect(
      f.batches.executeBatchItem.mock.calls.map(([input]) => input.workflowId),
    ).toEqual(ids);
    expect(f.authorization.findAccess).toHaveBeenCalledTimes(10);
  });

  it('ignores a retained guard proof, rereads authority before admission and each item, and stops on role loss', async () => {
    const f = fixture();
    const authorizedWorkspace = await authorizeWorkspace({
      actor,
      routeWorkspaceId: workspaceId,
      capability: 'workflow:update',
      access: f.authorization,
    });
    f.authorization.findAccess.mockClear();
    f.authorization.findAccess
      .mockResolvedValueOnce(access())
      .mockResolvedValueOnce(access())
      .mockResolvedValueOnce(access('viewer'));
    expect(
      await f.useCase.bulk({
        ...base,
        authorizedWorkspace,
        request: {
          ...move,
          items: [
            ...items,
            { workflowId: tagId, expectedOrganizationRevision: 4 },
          ],
        },
      }),
    ).toEqual({
      items: [
        updated(firstId),
        { workflowId: secondId, status: 'forbidden' },
        { workflowId: tagId, status: 'not_processed' },
      ],
    });
    expect(f.authorization.findAccess).toHaveBeenCalledTimes(3);
    expect(f.batches.executeBatchItem).toHaveBeenCalledOnce();
  });

  it('does not use a retained guard to admit a batch after membership departure', async () => {
    const f = fixture();
    const authorizedWorkspace = await authorizeWorkspace({
      actor,
      routeWorkspaceId: workspaceId,
      capability: 'workflow:update',
      access: f.authorization,
    });
    f.authorization.findAccess.mockClear();
    f.authorization.findAccess.mockResolvedValue(undefined);
    await expect(
      f.useCase.bulk({ ...base, authorizedWorkspace, request: move }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(f.authorization.findAccess).toHaveBeenCalledOnce();
    expect(f.batches.admitBatch).not.toHaveBeenCalled();
    expect(f.batches.executeBatchItem).not.toHaveBeenCalled();
  });

  it.each(['invisible', 'lost-role', 'lookup-outage'] as const)(
    'rechecks authority after SQL not-found: %s',
    async (mode) => {
      const f = fixture();
      f.batches.executeBatchItem.mockRejectedValueOnce(
        new WorkflowNotFoundError(),
      );
      f.authorization.findAccess
        .mockResolvedValueOnce(access())
        .mockResolvedValueOnce(access());
      if (mode === 'lost-role')
        f.authorization.findAccess.mockResolvedValueOnce(access('viewer'));
      else if (mode === 'lookup-outage')
        f.authorization.findAccess.mockRejectedValueOnce(
          new Error('private lookup transport detail'),
        );
      const status =
        mode === 'lost-role'
          ? 'forbidden'
          : mode === 'lookup-outage'
            ? 'outcome_unknown'
            : 'not_visible';
      expect(await f.useCase.bulk({ ...base, request: move })).toEqual({
        items: [
          { workflowId: firstId, status },
          mode === 'lost-role'
            ? { workflowId: secondId, status: 'not_processed' }
            : updated(secondId),
        ],
      });
      expect(f.authorization.findAccess).toHaveBeenCalledTimes(
        mode === 'lost-role' ? 3 : 4,
      );
      expect(f.batches.executeBatchItem).toHaveBeenCalledTimes(
        mode === 'lost-role' ? 1 : 2,
      );
    },
  );

  it('stops immediately on item authority loss without exposing revisions or receipt details', async () => {
    const f = fixture();
    f.batches.executeBatchItem.mockRejectedValueOnce(
      new AuthorizationError(
        'auth.forbidden',
        'historical revision 999 actor private',
      ),
    );
    expect(await f.useCase.bulk({ ...base, request: move })).toEqual({
      items: [
        { workflowId: firstId, status: 'forbidden' },
        { workflowId: secondId, status: 'not_processed' },
      ],
    });
    expect(f.batches.executeBatchItem).toHaveBeenCalledOnce();
    expect(f.authorization.findAccess).toHaveBeenCalledTimes(2);
  });

  it('recovers only by resubmitting the exact full request/key and delegates the shared cleanup parent namespace', async () => {
    const f = fixture();
    const parents = new Map<string, string>();
    f.batches.admitBatch.mockImplementation((input) => {
      const key = `${input.workspaceId}:${input.actorId}:${input.idempotencyKey}`;
      const identity = JSON.stringify(input.request);
      const previous = parents.get(key);
      if (previous !== undefined && previous !== identity)
        return Promise.reject(new IdempotencyConflictError());
      parents.set(key, identity);
      return Promise.resolve({ admitted: true });
    });
    f.batches.executeBatchItem.mockRejectedValueOnce(
      new Error('unknown first-item commit'),
    );
    expect((await f.useCase.bulk({ ...base, request: move })).items[0]).toEqual(
      { workflowId: firstId, status: 'outcome_unknown' },
    );
    f.batches.executeBatchItem.mockImplementation((input) =>
      Promise.resolve({ ...result(input), replayed: true }),
    );
    expect(await f.useCase.bulk({ ...base, request: move })).toEqual({
      items: [updated(firstId, 8, true), updated(secondId, 8, true)],
    });
    const admissions = f.batches.admitBatch.mock.calls.map(([input]) => input);
    expect(admissions[0]).toEqual(admissions[1]);
    expect(
      f.batches.executeBatchItem.mock.calls.map(
        ([input]) => input.idempotencyKey,
      ),
    ).toEqual(Array(4).fill(base.idempotencyKey));
    for (const changed of [
      { ...move, folderId: null },
      { ...move, items: [...items].reverse() },
      {
        ...move,
        items: [{ workflowId: firstId, expectedOrganizationRevision: 8 }],
      },
      {
        operation: 'replace_tags',
        tagIds: [],
        items: [{ workflowId: tagId, expectedOrganizationRevision: 1 }],
      },
    ]) {
      f.batches.executeBatchItem.mockClear();
      await expect(
        f.useCase.bulk({ ...base, request: changed }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
      expect(f.batches.executeBatchItem).not.toHaveBeenCalled();
    }
    await expect(
      f.useCase.cleanup({ ...base, request: cleanup }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(f.batches.executeBatchItem).not.toHaveBeenCalled();
    const cleanupInput = f.batches.admitBatch.mock.calls.at(-1)?.[0];
    expect(cleanupInput).toEqual({
      workspaceId,
      actorId,
      idempotencyKey: base.idempotencyKey,
      request: { operation: 'tag_cleanup', tagId, items },
    });
  });

  it.each(['owner', 'admin'] as const)(
    'admits %s cleanup using normalized full body, fresh authority and detached outcomes',
    async (role) => {
      const f = fixture(role);
      const request = {
        tagId: tagId.toUpperCase(),
        items: items.map((item) => ({
          ...item,
          workflowId: item.workflowId.toUpperCase(),
        })),
      };
      expect(await f.useCase.cleanup({ ...base, request })).toEqual({
        items: items.map((item) => ({
          ...updated(item.workflowId),
          status: 'detached',
        })),
      });
      expect(f.batches.admitBatch).toHaveBeenCalledExactlyOnceWith({
        workspaceId,
        actorId,
        idempotencyKey: base.idempotencyKey,
        request: { operation: 'tag_cleanup', tagId, items },
      });
      expect(f.authorization.findAccess).toHaveBeenCalledTimes(3);
      const expected = f.batches.admitBatch.mock.calls[0]?.[0];
      for (const [input] of f.batches.executeBatchItem.mock.calls)
        expect(input.request).toEqual(expected?.request);
    },
  );

  it.each(['builder', 'operator', 'viewer'] as const)(
    'denies %s cleanup before admission',
    async (role) => {
      const f = fixture(role);
      await expect(
        f.useCase.cleanup({ ...base, request: cleanup }),
      ).rejects.toBeInstanceOf(AuthorizationError);
      expect(f.batches.admitBatch).not.toHaveBeenCalled();
      expect(f.batches.executeBatchItem).not.toHaveBeenCalled();
    },
  );

  it('retains exact cleanup request/key on partial recovery and stops when admin role is lost', async () => {
    const f = fixture('admin');
    f.batches.executeBatchItem.mockRejectedValueOnce(
      new Error('cleanup outcome unknown'),
    );
    expect(
      (await f.useCase.cleanup({ ...base, request: cleanup })).items[0],
    ).toEqual({ workflowId: firstId, status: 'outcome_unknown' });
    f.batches.executeBatchItem.mockImplementation((input) =>
      Promise.resolve({ ...result(input), replayed: true }),
    );
    const recovered = await f.useCase.cleanup({ ...base, request: cleanup });
    expect(recovered).toEqual({
      items: items.map((item) => ({
        ...updated(item.workflowId, 8, true),
        status: 'detached',
      })),
    });
    expect(f.batches.admitBatch.mock.calls[0]?.[0]).toEqual(
      f.batches.admitBatch.mock.calls[1]?.[0],
    );
    f.authorization.findAccess
      .mockResolvedValueOnce(access('admin'))
      .mockResolvedValueOnce(access('builder'));
    f.batches.executeBatchItem.mockClear();
    expect(await f.useCase.cleanup({ ...base, request: cleanup })).toEqual({
      items: [
        { workflowId: firstId, status: 'forbidden' },
        { workflowId: secondId, status: 'not_processed' },
      ],
    });
    expect(f.batches.executeBatchItem).not.toHaveBeenCalled();
  });

  it.each(['bulk', 'cleanup'] as const)(
    'rejects strict invalid %s parents before authority or admission',
    async (method) => {
      const request = method === 'bulk' ? move : cleanup;
      for (const extra of [
        { actorId },
        { proof: true },
        { parentHash: folderId },
        { idempotencyKey: 'body-key' },
        { selectAll: true },
      ]) {
        const f = fixture();
        await expect(
          f.useCase[method]({ ...base, request: { ...request, ...extra } }),
        ).rejects.toBeInstanceOf(z.ZodError);
        expect(f.authorization.findAccess).not.toHaveBeenCalled();
        expect(f.batches.admitBatch).not.toHaveBeenCalled();
      }
      for (const selection of [
        [],
        [items[0], items[0]],
        [{ workflowId: firstId, expectedOrganizationRevision: 0 }],
        Array.from({ length: 51 }, (_, index) => ({
          workflowId: `${String(index).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
          expectedOrganizationRevision: 1,
        })),
      ]) {
        const f = fixture();
        await expect(
          f.useCase[method]({
            ...base,
            request: { ...request, items: selection },
          }),
        ).rejects.toBeInstanceOf(z.ZodError);
        expect(f.batches.admitBatch).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['move', 'replace_tags', 'tag_cleanup'] as const)(
    'converts malformed/private/mismatched %s item results to sanitized unknown, not success',
    async (operation) => {
      for (const malformed of [
        { workflowId: firstId, organizationRevision: 0, replayed: true },
        { workflowId: firstId, organizationRevision: 8, replayed: 'true' },
        { workflowId: secondId, organizationRevision: 8, replayed: true },
        {
          workflowId: firstId,
          organizationRevision: 8,
          replayed: true,
          actorId,
          proof: true,
        },
        { replayed: true },
      ]) {
        const f = fixture();
        f.batches.executeBatchItem.mockResolvedValueOnce({
          ...malformed,
          ...(operation === 'move' ? { folderId } : {}),
        } as unknown as WorkflowOrganizationBatchItemResult);
        const response =
          operation === 'tag_cleanup'
            ? await f.useCase.cleanup({ ...base, request: cleanup })
            : await f.useCase.bulk({
                ...base,
                request:
                  operation === 'move'
                    ? move
                    : { operation, tagIds: [], items },
              });
        expect(response.items[0]).toEqual({
          workflowId: firstId,
          status: 'outcome_unknown',
        });
        expect(response.items[1]).toEqual(
          operation === 'tag_cleanup'
            ? { ...updated(secondId), status: 'detached' }
            : updated(secondId),
        );
        expect(f.batches.executeBatchItem).toHaveBeenCalledTimes(2);
      }
    },
  );

  it('does not report an unrelated folder/tag conflict as a supported batch conflict', async () => {
    for (const request of [
      move,
      { operation: 'replace_tags', tagIds: [], items },
    ]) {
      const f = fixture();
      f.batches.executeBatchItem
        .mockRejectedValueOnce(new WorkflowFolderConflictError('name'))
        .mockRejectedValueOnce(new WorkflowTagConflictError('key'));
      expect(await f.useCase.bulk({ ...base, request })).toEqual({
        items: items.map((item) => ({
          workflowId: item.workflowId,
          status: 'outcome_unknown',
        })),
      });
    }
    const f = fixture();
    f.batches.executeBatchItem.mockRejectedValueOnce(
      new WorkflowFolderConflictError('not_visible'),
    );
    expect(
      (
        await f.useCase.bulk({
          ...base,
          request: { operation: 'replace_tags', tagIds: [], items },
        })
      ).items[0],
    ).toEqual({ workflowId: firstId, status: 'outcome_unknown' });
  });

  it.each([
    'before',
    'admission',
    'authority',
    'item',
    'not-found-recheck',
  ] as const)(
    'propagates abort at %s without fabricated unknown/remaining outcomes',
    async (phase) => {
      const f = fixture();
      const controller = new AbortController();
      const reason = new Error('explicit batch cancellation');
      if (phase === 'before') controller.abort(reason);
      if (phase === 'admission')
        f.batches.admitBatch.mockImplementationOnce(() => {
          controller.abort(reason);
          return Promise.resolve({ admitted: true });
        });
      if (phase === 'authority')
        f.authorization.findAccess
          .mockResolvedValueOnce(access())
          .mockImplementationOnce(() => {
            controller.abort(reason);
            return Promise.resolve(access());
          });
      if (phase === 'item')
        f.batches.executeBatchItem.mockImplementationOnce((input) => {
          controller.abort(reason);
          return Promise.resolve(result(input));
        });
      if (phase === 'not-found-recheck') {
        f.batches.executeBatchItem.mockRejectedValueOnce(
          new WorkflowNotFoundError(),
        );
        f.authorization.findAccess
          .mockResolvedValueOnce(access())
          .mockResolvedValueOnce(access())
          .mockImplementationOnce(() => {
            controller.abort(reason);
            return Promise.resolve(access());
          });
      }
      await expect(
        f.useCase.bulk({ ...base, request: move, signal: controller.signal }),
      ).rejects.toBe(reason);
      expect(f.batches.executeBatchItem).toHaveBeenCalledTimes(
        phase === 'item' || phase === 'not-found-recheck' ? 1 : 0,
      );
      expect(f.batches.admitBatch).toHaveBeenCalledTimes(
        phase === 'before' ? 0 : 1,
      );
    },
  );
});
