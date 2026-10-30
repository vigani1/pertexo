import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import { dataTableNewColumnsSchema } from '@pertexo/node-sdk';

import {
  actorId,
  identity,
  purgeTestWorkspace,
} from '../../support/workflow-authoring.js';
import { store, query } from './fixture.js';

// Plan 14: the workspace byte limit counts stored cell JSON (UTF-8 bytes) and
// accepts 64 KiB as its smallest value.
const byteLimit = 65_536;
const quotaExceeded = { code: 'quota_exceeded' };

export function registerEnforcesWorkspaceByteQuota(): void {
  it('refuses inserts, imports and growing updates past the workspace byte limit', async () => {
    const workspace = await boundedNotes();
    const { note, notes, stored, write } = workspace;
    try {
      const small = await workspace.measure('x');
      // Leaves room for one more small row and half of another.
      const headroom = Math.floor(small / 2);
      const filler = 'f'.repeat(byteLimit - small - headroom - small + 1);
      await write({
        operation: 'insert',
        table: notes,
        values: { note: filler },
      });
      expect(await stored()).toBe(byteLimit - small - headroom);

      const raced = await Promise.allSettled(
        ['a', 'b'].map((value) =>
          write({ operation: 'insert', table: notes, values: { note: value } }),
        ),
      );
      expect(raced.filter(({ status }) => status === 'fulfilled')).toHaveLength(
        1,
      );
      expect(
        raced.flatMap((result) =>
          result.status === 'rejected' ? [result.reason as unknown] : [],
        ),
      ).toEqual([expect.objectContaining(quotaExceeded)]);
      const kept = raced[0]?.status === 'fulfilled' ? 'a' : 'b';
      expect(await stored()).toBe(byteLimit - headroom);

      await expect(
        store.importRows({
          ...workspace.scope,
          tableId: workspace.tableId,
          idempotencyKey: randomUUID(),
          rows: [{ note: 'c' }],
        }),
      ).rejects.toMatchObject(quotaExceeded);
      await expect(
        write({
          operation: 'update',
          table: notes,
          query: note(kept),
          values: { note: kept.repeat(headroom + 2) },
        }),
      ).rejects.toMatchObject(quotaExceeded);
      expect(await stored()).toBe(byteLimit - headroom);

      await write({
        operation: 'update',
        table: notes,
        query: note(kept, 'not_equals'),
        values: { note: filler.slice(100) },
      });
      expect(await stored()).toBe(byteLimit - headroom - 100);
      await write({
        operation: 'update',
        table: notes,
        query: note(kept),
        values: { note: kept.repeat(headroom + 101) },
      });
      expect(await stored()).toBe(byteLimit);
    } finally {
      await purgeTestWorkspace(workspace.scope.workspaceId);
    }
  }, 30_000);
}

/** An isolated workspace at the smallest byte limit with one unkeyed text table. */
async function boundedNotes() {
  const created = await identity.createWorkspaceWithOwner({
    id: randomUUID(),
    name: 'Byte quota',
    slug: `bytes-${randomUUID()}`,
    ownerUserId: actorId,
    idempotencyKey: randomUUID(),
  });
  const scope = { workspaceId: created.id, actorId };
  await store.configure({
    ...scope,
    idempotencyKey: randomUUID(),
    tableLimit: 1,
    columnLimit: 1,
    rowLimit: 100,
    byteLimit,
  });
  const notes = 'Notes';
  const { id: tableId } = await store.create({
    ...scope,
    idempotencyKey: randomUUID(),
    name: notes,
    columns: dataTableNewColumnsSchema.parse([{ name: 'note', type: 'text' }]),
    keyColumn: null,
  });
  const write = (
    command: Parameters<typeof store.write>[0]['command'],
  ): ReturnType<typeof store.write> =>
    store.write({ ...scope, tableId, idempotencyKey: randomUUID(), command });
  const stored = async () => (await store.list(scope)).quotas.storedBytes;
  const note = (
    value: string,
    operator: 'equals' | 'not_equals' = 'equals',
  ) => ({ ...query, filters: [{ column: 'note', operator, value }] });
  /** Stores one row with this note, reads its bytes, then removes it. */
  const measure = async (value: string) => {
    const before = await stored();
    await write({ operation: 'insert', table: notes, values: { note: value } });
    const bytes = (await stored()) - before;
    await write({ operation: 'delete', table: notes, query: note(value) });
    expect(await stored()).toBe(before);
    return bytes;
  };
  return { scope, tableId, notes, write, stored, note, measure };
}
