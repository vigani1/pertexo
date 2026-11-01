import { expect, it } from 'vitest';

import { WorkflowNotFoundError } from '@pertexo/core/authoring';
import { IdempotencyConflictError } from '@pertexo/database/platform';
import { AuthorizationError } from '../../../../../src/authorization/index.js';

import {
  workspaceId,
  actorId,
  firstId,
  secondId,
  tagId,
  base,
  items,
  move,
  cleanup,
  access,
  updated,
  result,
  fixture,
} from './fixture.js';

export function registerRechecksAuthorityAfterSQLNotFound(): void {
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
      let status;
      if (mode === 'lost-role') {
        status = 'forbidden';
      } else if (mode === 'lookup-outage') {
        status = 'outcome_unknown';
      } else {
        status = 'not_visible';
      }
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
}
