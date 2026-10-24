import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import {
  dataTableNewColumnsSchema,
  type DataTableValues,
} from '@pertexo/node-sdk';

import { workspaceId, queryAsOwner } from '../../support/workflow-authoring.js';
import { store, scope, query, table, insert, required } from './fixture.js';

export function registerStoresTypedRowsFiltersSorts(): void {
  it('keeps text filters literal and ASCII-folded while comparing nullable cells', async () => {
    const f = await table();
    await store.importRows({
      ...scope(),
      tableId: f.id,
      idempotencyKey: randomUUID(),
      rows: [
        { key: 'A%_x', amount: null },
        { key: 'abx', amount: null },
        { key: 'ÄBC', amount: null },
      ],
    });
    for (const [value, count] of [
      ['%_', 1],
      ['ä', 0],
      ['a', 2],
    ] as const) {
      const found = await store.find({
        ...scope(),
        tableId: f.id,
        query: {
          ...query,
          filters: [{ column: 'key', operator: 'contains', value }],
        },
      });
      expect(found.rows).toHaveLength(count);
    }
    const empty = await store.find({
      ...scope(),
      tableId: f.id,
      query: {
        ...query,
        filters: [{ column: 'amount', operator: 'equals', value: null }],
      },
    });
    expect(empty.rows).toHaveLength(3);
    const filled = await store.find({
      ...scope(),
      tableId: f.id,
      query: {
        ...query,
        filters: [{ column: 'amount', operator: 'not_equals', value: null }],
      },
    });
    expect(filled.rows).toEqual([]);
  });

  it('stores typed rows, filters/sorts stable pages and preserves exact command receipts', async () => {
    const f = await table();
    const command = {
      ...scope(),
      tableId: f.id,
      command: {
        operation: 'insert' as const,
        table: f.name,
        values: { key: 'a', amount: 2, active: false },
      },
      idempotencyKey: randomUUID(),
    };
    const accepted = await store.write(command);
    expect(await store.write(command)).toEqual(accepted);
    await insert(f, 'b', 4);
    await insert(f, 'c', 3);
    const result = await store.find({
      ...scope(),
      tableId: f.id,
      query: {
        ...query,
        filters: [{ column: 'amount', operator: 'greater_than', value: 2 }],
        sort: { column: 'amount', direction: 'desc' },
        limit: 1,
      },
    });
    expect(result.hasMore).toBe(true);
    expect(result.rows[0]?.values).toEqual({
      key: 'b',
      amount: 4,
      active: true,
    });
    const next = await store.find({
      ...scope(),
      tableId: f.id,
      query: {
        ...query,
        sort: { column: 'amount', direction: 'asc' },
        offset: 1,
        limit: 1,
      },
    });
    expect(next.rows[0]?.values.amount).toBe(3);
  });

  it('finds text with contains whatever its capital letters', async () => {
    const f = await table();
    for (const key of ['Quoted-A', 'quoted-b', 'other']) await insert(f, key);
    const found = await store.find({
      ...scope(),
      tableId: f.id,
      query: {
        ...query,
        filters: [{ column: 'key', operator: 'contains', value: 'QUOTED' }],
        sort: { column: 'key', direction: 'asc' },
      },
    });
    expect(found.rows.map((row) => row.values.key)).toEqual([
      'Quoted-A',
      'quoted-b',
    ]);
  });

  it('keeps the columns an upsert of an existing row does not name', async () => {
    const f = await table();
    await insert(f, 'kept', 5);
    const upsert = (values: DataTableValues) =>
      store.write({
        ...scope(),
        tableId: f.id,
        idempotencyKey: randomUUID(),
        command: { operation: 'upsert', table: f.name, values },
      });
    const stored = async () =>
      (await store.find({ ...scope(), tableId: f.id, query })).rows[0]?.values;
    await upsert({ key: 'kept', amount: 7 });
    expect(await stored()).toEqual({ key: 'kept', amount: 7, active: true });
    await upsert({ key: 'kept', active: null });
    expect(await stored()).toEqual({ key: 'kept', amount: 7, active: null });
    await expect(upsert({ amount: 1 })).rejects.toMatchObject({
      code: 'invalid_values',
    });
  });

  it('stores and returns row values in column order', async () => {
    const f = await table();
    await store.write({
      ...scope(),
      tableId: f.id,
      idempotencyKey: randomUUID(),
      command: {
        operation: 'insert',
        table: f.name,
        values: { active: false, amount: 4, key: 'ordered' },
      },
    });
    const found = await store.find({ ...scope(), tableId: f.id, query });
    expect(Object.keys(found.rows[0]?.values ?? {})).toEqual([
      'key',
      'amount',
      'active',
    ]);
    const stored = await queryAsOwner<{ values_json: string }>(
      'select values_json from app.workspace_data_table_rows where workspace_id=$1 and table_id=$2',
      [workspaceId, f.id],
    );
    expect(stored[0]?.values_json).toBe(
      '{"key":"ordered","amount":4,"active":false}',
    );
  });

  it('still asks for every required column when an upsert inserts', async () => {
    const name = `People_${randomUUID().replaceAll('-', '')}`;
    const created = await store.create({
      ...scope(),
      name,
      columns: dataTableNewColumnsSchema.parse([
        { name: 'email', type: 'text', required: true },
        { name: 'name', type: 'text', required: true },
      ]),
      keyColumn: 'email',
      idempotencyKey: randomUUID(),
    });
    await expect(
      store.write({
        ...scope(),
        tableId: created.id,
        idempotencyKey: randomUUID(),
        command: {
          operation: 'upsert',
          table: name,
          values: { email: 'a@b.co' },
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_values' });
  });

  it('serializes concurrent upserts and refuses duplicate keys and stale row revisions', async () => {
    const f = await table();
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.write({
          ...scope(),
          tableId: f.id,
          idempotencyKey: randomUUID(),
          command: {
            operation: 'upsert',
            table: f.name,
            values: { key: 'only', amount: index },
          },
        }),
      ),
    );
    let found = await store.find({ ...scope(), tableId: f.id, query });
    expect(found.rows).toHaveLength(1);
    expect(found.rows[0]?.revision).toBe(8);
    await expect(insert(f, 'only')).rejects.toMatchObject({
      code: 'key_conflict',
    });
    const row = required(found.rows[0]);
    const edit = {
      ...scope(),
      tableId: f.id,
      rowId: row.id,
      expectedRevision: row.revision,
      idempotencyKey: randomUUID(),
      command: {
        operation: 'update' as const,
        table: f.name,
        query,
        values: { amount: 99 },
      },
    };
    await store.write(edit);
    await expect(
      store.write({ ...edit, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'conflict' });
    found = await store.find({ ...scope(), tableId: f.id, query });
    expect(found.rows[0]?.values).toEqual({
      key: 'only',
      amount: 99,
      active: null,
    });
  });
}
