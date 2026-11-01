import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { query, store } from '../records/fixture.js';
import {
  insertOrder,
  newWorkspace,
  ordersTable,
  snapshot,
  type Actor,
} from './world.js';

const onKey = (value: string) => ({
  ...query,
  filters: [{ column: 'key', operator: 'equals' as const, value }],
});

export function registerFilteredWrites(): void {
  it('reports 0 affected and creates no row when an update matches nothing', async () => {
    const actor = await newWorkspace();
    const table = await ordersTable(actor, 'key');
    const write = (values: Record<string, unknown>) =>
      store.write({
        ...actor,
        tableId: table.id,
        idempotencyKey: randomUUID(),
        command: {
          operation: 'update',
          table: table.name,
          query: onKey('missing'),
          values: values as never,
        },
      });

    // An empty table, with every column named: nothing stands between this and an insert.
    await expect(
      write({ key: 'missing', amount: 5, active: true }),
    ).resolves.toEqual({ rows: [], affected: 0 });
    expect((await snapshot(actor, table.id)).rows).toEqual([]);

    await insertOrder(actor, table, 'a');
    const before = await snapshot(actor, table.id);
    await expect(write({ amount: 5 })).resolves.toMatchObject({ affected: 0 });
    expect(await snapshot(actor, table.id)).toEqual(before);
  });

  it('reports 0 affected when a delete matches nothing', async () => {
    const actor = await newWorkspace();
    const table = await ordersTable(actor, 'key');
    await insertOrder(actor, table, 'a');
    const before = await snapshot(actor, table.id);
    await expect(
      store.write({
        ...actor,
        tableId: table.id,
        idempotencyKey: randomUUID(),
        command: {
          operation: 'delete',
          table: table.name,
          query: onKey('missing'),
        },
      }),
    ).resolves.toMatchObject({ affected: 0 });
    expect(await snapshot(actor, table.id)).toEqual(before);
  });

  it('conflicts on a named-row update of a row that is not there, and creates nothing', async () => {
    const actor = await newWorkspace();
    const table = await ordersTable(actor, 'key');
    await insertOrder(actor, table, 'a');
    const before = await snapshot(actor, table.id);
    await expect(
      store.write({
        ...actor,
        tableId: table.id,
        idempotencyKey: randomUUID(),
        rowId: randomUUID(),
        expectedRevision: 1,
        command: {
          operation: 'update',
          table: table.name,
          query,
          values: { key: 'b', amount: 2, active: false },
        },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await snapshot(actor, table.id)).toEqual(before);
  });

  it('inserts on an upsert with no match, then patches and keeps the columns it does not name', async () => {
    const actor = await newWorkspace();
    const table = await ordersTable(actor, 'key');
    const upsert = (values: {
      key: string;
      amount: number;
      active?: boolean;
    }) =>
      store.write({
        ...actor,
        tableId: table.id,
        idempotencyKey: randomUUID(),
        command: { operation: 'upsert', table: table.name, values },
      });

    const inserted = await upsert({ key: 'a', amount: 1, active: true });
    expect(inserted.affected).toBe(1);
    expect(inserted.rows).toEqual([expect.objectContaining({ revision: 1 })]);
    const patched = await upsert({ key: 'a', amount: 2 });
    expect(patched.affected).toBe(1);
    expect(patched.rows).toEqual([
      expect.objectContaining({ id: inserted.rows[0]?.id, revision: 2 }),
    ]);
    const { rows, tables } = await snapshot(actor, table.id);
    expect(rows.map(({ values }) => values)).toEqual([
      { key: 'a', amount: 2, active: true },
    ]);
    expect(tables.find(({ id }) => id === table.id)?.rowCount).toBe(1);
  });

  it('refuses an upsert on a table with no key column and writes nothing', async () => {
    const actor = await newWorkspace();
    const table = await ordersTable(actor, null);
    const before = await snapshot(actor, table.id);
    await expect(
      store.write({
        ...actor,
        tableId: table.id,
        idempotencyKey: randomUUID(),
        command: {
          operation: 'upsert',
          table: table.name,
          values: { key: 'a', amount: 1 },
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_values' });
    expect(await snapshot(actor, table.id)).toEqual(before);
  });

  const unsafeQueries = [
    ['no filter', query, 'unsafe_filter'],
    [
      'a sort',
      { ...onKey('a'), sort: { column: 'amount', direction: 'asc' as const } },
      'invalid_values',
    ],
    ['an offset', { ...onKey('a'), offset: 1 }, 'invalid_values'],
  ] as const;

  it.each(unsafeQueries)(
    'refuses a filtered write with %s and changes nothing',
    async (_name, unsafe, code) => {
      const actor = await newWorkspace();
      const table = await ordersTable(actor, 'key');
      await insertOrder(actor, table, 'a');
      await insertOrder(actor, table, 'b');
      const before = await snapshot(actor, table.id);
      await expect(
        store.write({
          ...actor,
          tableId: table.id,
          idempotencyKey: randomUUID(),
          command: {
            operation: 'update',
            table: table.name,
            query: unsafe,
            values: { amount: 9 },
          },
        }),
      ).rejects.toMatchObject({ code });
      await expect(
        store.write({
          ...actor,
          tableId: table.id,
          idempotencyKey: randomUUID(),
          command: {
            operation: 'delete',
            table: table.name,
            query: unsafe,
          },
        }),
      ).rejects.toMatchObject({ code });
      expect(await snapshot(actor, table.id)).toEqual(before);
    },
  );

  it('refuses a filtered write over 1,000 matches, changes nothing, and takes exactly 1,000', async () => {
    const actor = await newWorkspace();
    const table = await ordersTable(actor, 'key');
    await importOrders(actor, table.id, { from: 0, count: 1000, amount: 7 });
    await importOrders(actor, table.id, { from: 1000, count: 1, amount: 8 });
    const everyRow = {
      ...query,
      filters: [
        { column: 'amount', operator: 'greater_than' as const, value: 0 },
      ],
    };
    const before = (await store.list(actor)).quotas;
    const countOf = async (amount: number) =>
      (
        await store.find({
          ...actor,
          tableId: table.id,
          query: {
            filters: [{ column: 'amount', operator: 'equals', value: amount }],
            limit: 1,
            offset: 0,
          },
        })
      ).rows.length;

    for (const command of [
      {
        operation: 'update' as const,
        table: table.name,
        query: everyRow,
        values: { amount: 99 },
      },
      { operation: 'delete' as const, table: table.name, query: everyRow },
    ])
      await expect(
        store.write({
          ...actor,
          tableId: table.id,
          idempotencyKey: randomUUID(),
          command,
        }),
      ).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect((await store.list(actor)).quotas).toEqual(before);
    expect(await countOf(99)).toBe(0);
    expect(
      (await store.list(actor)).tables.find(({ id }) => id === table.id)
        ?.rowCount,
    ).toBe(1001);

    const exact = await store.write({
      ...actor,
      tableId: table.id,
      idempotencyKey: randomUUID(),
      command: {
        operation: 'update',
        table: table.name,
        query: {
          ...query,
          filters: [{ column: 'amount', operator: 'equals', value: 7 }],
        },
        values: { amount: 99 },
      },
    });
    expect(exact.affected).toBe(1000);
    expect(await countOf(99)).toBe(1);
  }, 30_000);
}

function importOrders(
  actor: Actor,
  tableId: string,
  rows: Readonly<{ from: number; count: number; amount: number }>,
) {
  return store.importRows({
    ...actor,
    tableId,
    idempotencyKey: randomUUID(),
    rows: Array.from({ length: rows.count }, (_, index) => ({
      key: `row_${String(rows.from + index)}`,
      amount: rows.amount,
    })),
  });
}
