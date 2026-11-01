import { expect, it } from 'vitest';

import {
  WorkflowFolderConflictError,
  WorkflowNotFoundError,
  WorkflowTagConflictError,
  type WorkflowOrganizationBatchItemResult,
} from '@pertexo/core/authoring';
import { IdempotencyConflictError } from '@pertexo/database/platform';
import {
  AuthorizationError,
  authorizeWorkspace,
} from '../../../../../src/authorization/index.js';

import {
  workspaceId,
  actorId,
  firstId,
  secondId,
  folderId,
  tagId,
  actor,
  base,
  items,
  move,
  access,
  updated,
  result,
  fixture,
  deferred,
} from './fixture.js';

export function registerNormalizesFullParentWithoutReorderingSelection(): void {
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
      .mockRejectedValueOnce(new Error('transient item failure'))
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
        { workflowId: ids[6], status: 'outcome_unknown' },
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
}
