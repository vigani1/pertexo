import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  WorkflowFolderConflictError,
  WorkflowNotFoundError,
  WorkflowTagConflictError,
  type WorkflowOrganizationBatchItemResult,
} from '@pertexo/core/authoring';

import {
  actorId,
  firstId,
  secondId,
  folderId,
  base,
  items,
  move,
  cleanup,
  access,
  updated,
  result,
  fixture,
} from './fixture.js';

export function registerRejectsStrictInvalidSParentsBefore(): void {
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
}
