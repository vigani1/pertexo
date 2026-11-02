import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import {
  otherActorId,
  workspaceId,
  queryAsOwner,
} from '../../support/workflow-authoring.js';

import { store, scope, create, current, edit, rows } from './fixture.js';
import { WorkspaceAccessDeniedError } from '../../../src/shared/errors.js';

export function registerKeepsColumnIDsThroughRename(): void {
  it('keeps column IDs through rename, rewrites every row and charges exact bytes', async () => {
    const table = await create();
    await store.importRows({
      ...scope(),
      tableId: table.id,
      idempotencyKey: randomUUID(),
      rows: [
        { key: 'a', amount: 1 },
        { key: 'b', amount: 2 },
      ],
    });
    const before = await current(table.id);
    const change = {
      ...scope(),
      tableId: table.id,
      expectedRevision: before.revision,
      change: {
        operation: 'rename_column' as const,
        columnId: 'key',
        name: 'order_key',
      },
      idempotencyKey: randomUUID(),
    };
    const result = await store.editSchema(change);
    expect(await store.editSchema(change)).toEqual(result);
    const renamed = await current(table.id);
    expect(renamed.columns[0]).toMatchObject({ id: 'key', name: 'order_key' });
    expect(renamed.keyColumn).toBe('order_key');
    expect((await rows(table.id)).map((row) => row.values)).toEqual([
      { order_key: 'a', amount: 1, note: null },
      { order_key: 'b', amount: 2, note: null },
    ]);
    const actual = await queryAsOwner<{ bytes: string }>(
      'select sum(octet_length(values_json))::text bytes from app.workspace_data_table_rows where table_id=$1',
      [table.id],
    );
    expect(renamed.storedBytes).toBe(Number(actual[0]?.bytes));
    const audit = await queryAsOwner<{ metadata: unknown }>(
      "select metadata from app.audit_events where target_id=$1 and action='data.table_schema_changed'",
      [table.id],
      workspaceId,
    );
    expect(audit).toHaveLength(1);
  });

  it('backfills typed defaults, rejects missing/oversized defaults atomically and never reuses a removed ID', async () => {
    const table = await create();
    await store.importRows({
      ...scope(),
      tableId: table.id,
      idempotencyKey: randomUUID(),
      rows: [
        { key: 'a', amount: 1 },
        { key: 'b', amount: 2 },
      ],
    });
    const before = await current(table.id);
    await expect(
      edit(table.id, {
        operation: 'add_column',
        column: { name: 'required_flag', type: 'boolean', required: true },
      }),
    ).rejects.toThrow(
      'Give the required column required_flag a default for existing rows.',
    );
    await expect(
      edit(table.id, {
        operation: 'add_column',
        column: { name: 'blank_text', type: 'text', required: true },
        defaultValue: '  ',
      }),
    ).rejects.toThrow('a default for existing rows');
    await expect(
      edit(table.id, {
        operation: 'add_column',
        column: { name: 'large', type: 'text', required: true },
        defaultValue: 'x'.repeat(65536),
      }),
    ).rejects.toThrow('64 KiB');
    expect(await current(table.id)).toEqual(before);
    await edit(table.id, {
      operation: 'add_column',
      column: { name: 'flag', type: 'boolean', required: true },
      defaultValue: false,
    });
    const added = (await current(table.id)).columns.find(
      (column) => column.name === 'flag',
    );
    if (added === undefined) throw new Error('Added column missing');
    expect(
      (await rows(table.id)).every((row) => row.values.flag === false),
    ).toBe(true);
    await edit(table.id, {
      operation: 'remove_column',
      columnId: added.id,
      confirm: true,
    });
    await edit(table.id, {
      operation: 'add_column',
      column: { name: 'flag', type: 'boolean', required: false },
    });
    expect(
      (await current(table.id)).columns.find((column) => column.name === 'flag')
        ?.id,
    ).not.toBe(added.id);
    expect(
      (await rows(table.id)).every((row) => row.values.flag === null),
    ).toBe(true);
  });

  it('changes keys only when all values qualify, rolls back collisions and clears a deleted key', async () => {
    const table = await create();
    await store.importRows({
      ...scope(),
      tableId: table.id,
      idempotencyKey: randomUUID(),
      rows: [
        { key: 'a', amount: 1 },
        { key: 'b', amount: 1 },
      ],
    });
    const before = await current(table.id);
    await expect(
      edit(table.id, { operation: 'set_key', columnId: 'amount' }),
    ).rejects.toMatchObject({ code: 'key_conflict' });
    expect(await current(table.id)).toEqual(before);
    await expect(
      edit(table.id, { operation: 'set_key', columnId: 'note' }),
    ).rejects.toThrow('required');
    await edit(table.id, { operation: 'set_key', columnId: null });
    await store.importRows({
      ...scope(),
      tableId: table.id,
      idempotencyKey: randomUUID(),
      rows: [{ key: 'a', amount: 2 }],
    });
    await expect(
      edit(table.id, { operation: 'set_key', columnId: 'key' }),
    ).rejects.toMatchObject({ code: 'key_conflict' });
    await edit(table.id, {
      operation: 'remove_column',
      columnId: 'key',
      confirm: true,
    });
    expect((await current(table.id)).keyColumn).toBeNull();
    expect(
      (await rows(table.id)).every((row) => !Object.hasOwn(row.values, 'key')),
    ).toBe(true);
  });

  it('serializes competing schema edits and keeps authority/quota fences', async () => {
    const table = await create();
    const before = await current(table.id);
    const results = await Promise.allSettled(
      ['total', 'price'].map((name) =>
        store.editSchema({
          ...scope(),
          tableId: table.id,
          expectedRevision: before.revision,
          change: { operation: 'rename_column', columnId: 'amount', name },
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    await expect(
      store.editSchema({
        ...scope(),
        actorId: otherActorId,
        tableId: table.id,
        expectedRevision: (await current(table.id)).revision,
        change: { operation: 'set_key', columnId: null },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    await store.configure({
      ...scope(),
      tableLimit: 20,
      columnLimit: 4,
      rowLimit: 10000,
      byteLimit: 65536,
      idempotencyKey: randomUUID(),
    });
    await edit(table.id, {
      operation: 'add_column',
      column: { name: 'fourth', type: 'text', required: false },
    });
    await expect(
      edit(table.id, {
        operation: 'add_column',
        column: { name: 'fifth', type: 'text', required: false },
      }),
    ).rejects.toMatchObject({ code: 'quota_exceeded' });
    await store.configure({
      ...scope(),
      tableLimit: 20,
      columnLimit: 20,
      rowLimit: 10000,
      byteLimit: 52428800,
      idempotencyKey: randomUUID(),
    });
  });
}
