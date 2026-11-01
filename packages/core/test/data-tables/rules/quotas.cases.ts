import { randomUUID } from 'node:crypto';

import { dataTableNewColumnsSchema } from '@pertexo/node-sdk';
import { expect, it } from 'vitest';

import { queryAsOwner } from '../../support/workflow-authoring.js';
import { query, store } from '../records/fixture.js';
import {
  insertOrder,
  newWorkspace,
  ordersTable,
  revisionOf,
  snapshot,
  type Actor,
} from './world.js';

const quotaExceeded = { code: 'quota_exceeded' };

/** What the counters say against what is really stored: one read and one recount. */
async function expectCountersMatchRows(actor: Actor, tableId: string) {
  const recount = await queryAsOwner<{ rows: number; bytes: number }>(
    `select count(*)::int as rows,
       coalesce(sum(octet_length(values_json)),0)::int as bytes
     from app.workspace_data_table_rows where workspace_id=$1 and table_id=$2`,
    [actor.workspaceId, tableId],
    actor.workspaceId,
  );
  const stored = recount[0];
  const { tables, quotas } = await store.list(actor);
  const table = tables.find(({ id }) => id === tableId);
  expect(table).toMatchObject({
    rowCount: stored?.rows,
    storedBytes: stored?.bytes,
  });
  expect(quotas.storedBytes).toBe(stored?.bytes);
  return stored;
}

export function registerQuotas(): void {
  it('keeps row and byte counters equal to what is stored through every kind of change', async () => {
    const actor = await newWorkspace();
    const table = await ordersTable(actor, 'key');
    expect((await store.list(actor)).quotas.tableCount).toBe(1);
    const once = () => ({
      ...actor,
      tableId: table.id,
      idempotencyKey: randomUUID(),
    });
    const onKey = (value: string) => ({
      ...query,
      filters: [{ column: 'key', operator: 'equals' as const, value }],
    });
    const check = () => expectCountersMatchRows(actor, table.id);
    const edit = async (
      change: Parameters<typeof store.editSchema>[0]['change'],
    ) =>
      store.editSchema({
        ...once(),
        expectedRevision: await revisionOf(actor, table.id),
        change,
      });

    await insertOrder(actor, table, 'a', 1);
    expect((await check())?.rows).toBe(1);

    await store.write({
      ...once(),
      command: {
        operation: 'update',
        table: table.name,
        query: onKey('a'),
        values: { key: `a${'x'.repeat(50)}` },
      },
    });
    await check();

    await store.write({
      ...once(),
      command: {
        operation: 'upsert',
        table: table.name,
        values: { key: 'b', amount: 2 },
      },
    });
    expect((await check())?.rows).toBe(2);

    await store.write({
      ...once(),
      command: {
        operation: 'upsert',
        table: table.name,
        values: { key: 'b', amount: 20 },
      },
    });
    expect((await check())?.rows).toBe(2);

    await store.importRows({
      ...once(),
      rows: [
        { key: 'c', amount: 3 },
        { key: 'd', amount: 4 },
      ],
    });
    expect((await check())?.rows).toBe(4);

    await store.importRows({
      ...once(),
      csv: 'key\ne\n',
      prepareRows: () => [{ key: 'e' }],
    });
    expect((await check())?.rows).toBe(5);

    await store.write({
      ...once(),
      command: { operation: 'delete', table: table.name, query: onKey('c') },
    });
    expect((await check())?.rows).toBe(4);

    const beforeRename = (await store.list(actor)).quotas.storedBytes;
    await edit({
      operation: 'rename_column',
      columnId: 'amount',
      name: 'amount_in_cents',
    });
    expect((await check())?.rows).toBe(4);
    expect((await store.list(actor)).quotas.storedBytes).toBeGreaterThan(
      beforeRename,
    );

    await edit({
      operation: 'add_column',
      column: { name: 'note', type: 'text', required: false },
      defaultValue: 'filled in',
    });
    expect((await check())?.rows).toBe(4);

    const added = (await store.list(actor)).tables
      .find(({ id }) => id === table.id)
      ?.columns.find(({ name }) => name === 'note');
    if (added === undefined) throw new Error('Added column missing');
    await edit({
      operation: 'remove_column',
      columnId: added.id,
      confirm: true,
    });
    await edit({
      operation: 'remove_column',
      columnId: 'active',
      confirm: true,
    });
    expect((await check())?.rows).toBe(4);

    await store.remove({
      ...once(),
      expectedRevision: await revisionOf(actor, table.id),
    });
    expect((await store.list(actor)).quotas).toMatchObject({
      tableCount: 0,
      storedBytes: 0,
    });
  });

  it('changes nothing when a table, column or row goes over its limit', async () => {
    const actor = await newWorkspace();
    const table = await ordersTable(actor, 'key');
    await insertOrder(actor, table, 'a');
    await insertOrder(actor, table, 'b');
    await store.configure({
      ...actor,
      idempotencyKey: randomUUID(),
      tableLimit: 1,
      columnLimit: 3,
      rowLimit: 2,
      byteLimit: 65_536,
    });
    const before = await snapshot(actor, table.id);
    const once = () => ({ ...actor, idempotencyKey: randomUUID() });

    await expect(
      store.create({
        ...once(),
        name: 'One_too_many',
        columns: dataTableNewColumnsSchema.parse([
          { name: 'note', type: 'text' },
        ]),
      }),
    ).rejects.toMatchObject(quotaExceeded);
    await expect(
      store.editSchema({
        ...once(),
        tableId: table.id,
        expectedRevision: await revisionOf(actor, table.id),
        change: {
          operation: 'add_column',
          column: { name: 'fourth', type: 'text', required: false },
        },
      }),
    ).rejects.toMatchObject(quotaExceeded);
    await expect(insertOrder(actor, table, 'c')).rejects.toMatchObject(
      quotaExceeded,
    );
    await expect(
      store.write({
        ...once(),
        tableId: table.id,
        command: {
          operation: 'upsert',
          table: table.name,
          values: { key: 'c', amount: 1 },
        },
      }),
    ).rejects.toMatchObject(quotaExceeded);
    await expect(
      store.importRows({
        ...once(),
        tableId: table.id,
        rows: [{ key: 'c', amount: 1 }],
      }),
    ).rejects.toMatchObject(quotaExceeded);

    expect(await snapshot(actor, table.id)).toEqual(before);
    await expectCountersMatchRows(actor, table.id);

    // Full is not frozen: patching an existing row still works.
    await expect(
      store.write({
        ...once(),
        tableId: table.id,
        command: {
          operation: 'upsert',
          table: table.name,
          values: { key: 'a', amount: 9 },
        },
      }),
    ).resolves.toMatchObject({ affected: 1 });
  });

  it('refuses a schema rewrite that would go over the byte limit and changes nothing', async () => {
    const actor = await newWorkspace();
    await store.configure({
      ...actor,
      idempotencyKey: randomUUID(),
      tableLimit: 1,
      columnLimit: 3,
      rowLimit: 10,
      byteLimit: 65_536,
    });
    const name = 'Notes';
    const { id } = await store.create({
      ...actor,
      idempotencyKey: randomUUID(),
      name,
      columns: dataTableNewColumnsSchema.parse([
        { name: 'note', type: 'text' },
      ]),
      keyColumn: null,
    });
    const once = () => ({
      ...actor,
      tableId: id,
      idempotencyKey: randomUUID(),
    });
    const insert = (note: string) =>
      store.write({
        ...once(),
        command: { operation: 'insert', table: name, values: { note } },
      });
    // Split across rows, so the workspace limit stops this and not one row's size.
    await insert('x');
    const overhead = (await store.list(actor)).quotas.storedBytes - 1;
    const room = 10;
    await insert('y'.repeat(32_000));
    await insert('z'.repeat(65_536 - 3 * overhead - 1 - 32_000 - room));
    const before = await snapshot(actor, id);
    expect(before.quotas.storedBytes).toBe(65_536 - room);

    await expect(
      store.editSchema({
        ...once(),
        expectedRevision: await revisionOf(actor, id),
        change: {
          operation: 'rename_column',
          columnId: 'note',
          name: 'a_note_with_a_much_longer_name',
        },
      }),
    ).rejects.toMatchObject(quotaExceeded);
    await expect(
      store.editSchema({
        ...once(),
        expectedRevision: await revisionOf(actor, id),
        change: {
          operation: 'add_column',
          column: { name: 'extra', type: 'text', required: false },
          defaultValue: 'more than the ten bytes left',
        },
      }),
    ).rejects.toMatchObject(quotaExceeded);

    expect(await snapshot(actor, id)).toEqual(before);
    await expectCountersMatchRows(actor, id);
  });
}
