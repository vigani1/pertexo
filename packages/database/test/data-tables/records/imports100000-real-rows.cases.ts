import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';

import {
  actorId,
  identity,
  queryAsOwner,
  purgeTestWorkspace,
} from '../../support/workflow-authoring.js';
import { store, scope, columns, query, insert } from './fixture.js';

export function registerImports100000RealRows(): void {
  it('imports 100,000 real rows in bounded batches, accounts bytes exactly and refuses the next row', async () => {
    const isolated = await identity.createWorkspaceWithOwner({
      id: randomUUID(),
      name: 'Maximum table proof',
      slug: `max-tables-${randomUUID()}`,
      ownerUserId: actorId,
      idempotencyKey: randomUUID(),
    });
    const scope = { workspaceId: isolated.id, actorId };
    await store.configure({
      ...scope,
      idempotencyKey: randomUUID(),
      tableLimit: 100,
      columnLimit: 50,
      rowLimit: 100000,
      byteLimit: 1073741824,
    });
    const f = await store.create({
      ...scope,
      idempotencyKey: randomUUID(),
      name: 'Maximum',
      columns,
      keyColumn: 'key',
    });
    const started = performance.now();
    for (let page = 0; page < 100; page++)
      await store.importRows({
        ...scope,
        tableId: f.id,
        idempotencyKey: randomUUID(),
        rows: Array.from({ length: 1000 }, (_, index) => ({
          key: `row-${String(page * 1000 + index).padStart(6, '0')}`,
          amount: index,
          active: true,
        })),
      });
    const importedMillis = performance.now() - started;
    const readStarted = performance.now();
    const result = await store.find({
      ...scope,
      tableId: f.id,
      query: {
        filters: [{ column: 'amount', operator: 'equals', value: 999 }],
        sort: { column: 'key', direction: 'desc' },
        limit: 1000,
        offset: 0,
      },
    });
    const readMillis = performance.now() - readStarted;
    expect(result.rows).toHaveLength(100);
    expect(result.rows[0]?.values.key).toBe('row-099999');
    await expect(
      store.write({
        ...scope,
        tableId: f.id,
        idempotencyKey: randomUUID(),
        command: {
          operation: 'insert',
          table: 'Maximum',
          values: { key: 'overflow', amount: 1 },
        },
      }),
    ).rejects.toMatchObject({ code: 'quota_exceeded' });
    const facts = await queryAsOwner<{ rows: number; bytes: number }>(
      'select count(*)::int rows,sum(octet_length(values_json))::int bytes from app.workspace_data_table_rows where workspace_id=$1',
      [isolated.id],
      isolated.id,
    );
    const list = await store.list(scope);
    expect(list.tables[0]?.rowCount).toBe(100000);
    expect(list.quotas.storedBytes).toBe(facts[0]?.bytes);
    process.stdout.write(
      `F14 maximum evidence ${JSON.stringify({ rows: 100000, importedMillis, readMillis, storedBytes: list.quotas.storedBytes, resultBytes: Buffer.byteLength(JSON.stringify(result)) })}\n`,
    );
    await purgeTestWorkspace(isolated.id, { pageSize: 1000 });
  }, 90_000);

  it('names a table in words and writes to it by that name', async () => {
    const name = `Customer orders ${randomUUID().slice(0, 8)}`;
    const created = await store.create({
      ...scope(),
      name,
      columns,
      keyColumn: 'key',
      idempotencyKey: randomUUID(),
    });
    await insert({ ...created, name }, 'spaced', 3);
    expect(
      (await store.find({ ...scope(), tableId: created.id, query })).rows[0]
        ?.values,
    ).toEqual({ key: 'spaced', amount: 3, active: true });
    // Storage keeps the same rule as the contract.
    await expect(
      queryAsOwner(
        `update app.workspace_data_tables set name=' padded' where id=$1`,
        [created.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
}
