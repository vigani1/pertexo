import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';

import { store, scope, query, table, insert } from './fixture.js';

export function registerUpdatesMatchingRowsAtomically(): void {
  it('updates every matching row once, keeps other columns and charges the exact byte change', async () => {
    const f = await table();
    for (const [key, amount] of [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ] as const)
      await insert(f, key, amount);
    const before = (await store.list(scope())).quotas.storedBytes;

    const updated = await store.write({
      ...scope(),
      tableId: f.id,
      idempotencyKey: randomUUID(),
      command: {
        operation: 'update',
        table: f.name,
        query: {
          ...query,
          filters: [{ column: 'amount', operator: 'less_than', value: 3 }],
        },
        values: { active: false },
      },
    });

    expect(updated.affected).toBe(2);
    const rows = (await store.find({ ...scope(), tableId: f.id, query })).rows;
    expect(
      rows
        .map(({ revision, values }) => ({ revision, values }))
        .toSorted((left, right) =>
          String(left.values.key).localeCompare(String(right.values.key)),
        ),
    ).toEqual([
      { revision: 2, values: { key: 'a', amount: 1, active: false } },
      { revision: 2, values: { key: 'b', amount: 2, active: false } },
      { revision: 1, values: { key: 'c', amount: 3, active: true } },
    ]);
    // Stored cell JSON: each `false` is one byte longer than `true`.
    expect((await store.list(scope())).quotas.storedBytes).toBe(before + 2);
  });

  it('refuses an update that gives two matching rows one key and changes nothing', async () => {
    const f = await table();
    await insert(f, 'a', 1);
    await insert(f, 'b', 2);
    const before = await store.list(scope());
    const rowsBefore = (await store.find({ ...scope(), tableId: f.id, query }))
      .rows;

    await expect(
      store.write({
        ...scope(),
        tableId: f.id,
        idempotencyKey: randomUUID(),
        command: {
          operation: 'update',
          table: f.name,
          query: {
            ...query,
            filters: [{ column: 'amount', operator: 'less_than', value: 3 }],
          },
          values: { key: 'same' },
        },
      }),
    ).rejects.toMatchObject({ code: 'key_conflict' });
    await expect(
      store.find({ ...scope(), tableId: f.id, query }),
    ).resolves.toMatchObject({ rows: rowsBefore });
    expect((await store.list(scope())).quotas.storedBytes).toBe(
      before.quotas.storedBytes,
    );
  });
}
