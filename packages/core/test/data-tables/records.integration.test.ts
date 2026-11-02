import { beforeAll, afterAll, it, expect } from 'vitest';
import {
  beforeAllFixture1,
  afterAllFixture2,
  store,
  scope,
  query,
  table,
  insert,
  required,
  columns,
} from './records/fixture.js';
import { randomUUID } from 'node:crypto';
import {
  dataTableNewColumnsSchema,
  type DataTableValues,
} from '@pertexo/node-sdk';
import {
  workspaceId,
  queryAsOwner,
  apiPool,
  actorId,
  otherActorId,
  otherWorkspaceId,
  identity,
  purgeTestWorkspace,
} from '../support/workflow-authoring.js';
import { withTenantScopedReadClient } from '@pertexo/database/primitives';
import { WorkspaceAccessDeniedError } from '../../src/shared/errors.js';

// Plan 14: the workspace byte limit counts stored cell JSON (UTF-8 bytes) and
// accepts 64 KiB as its smallest value.
const byteLimit = 65_536;

const quotaExceeded = { code: 'quota_exceeded' };

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

beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
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
it('keeps imports atomic and prevents empty-filter writes', async () => {
  const f = await table();
  await expect(
    store.importRows({
      ...scope(),
      tableId: f.id,
      idempotencyKey: randomUUID(),
      rows: [
        { key: 'valid', amount: 1 },
        { key: 'bad', amount: 'wrong' },
      ],
    }),
  ).rejects.toThrow('needs number');
  expect(
    (await store.find({ ...scope(), tableId: f.id, query })).rows,
  ).toHaveLength(0);
  await insert(f, 'a');
  await expect(
    store.write({
      ...scope(),
      tableId: f.id,
      idempotencyKey: randomUUID(),
      command: { operation: 'delete', table: f.name, query },
    }),
  ).rejects.toMatchObject({ code: 'unsafe_filter' });
  const removed = await store.write({
    ...scope(),
    tableId: f.id,
    idempotencyKey: randomUUID(),
    command: {
      operation: 'delete',
      table: f.name,
      query: {
        ...query,
        filters: [{ column: 'key', operator: 'equals', value: 'a' }],
      },
    },
  });
  expect(removed.affected).toBe(1);
});

it('rolls a late unique-key clash back with every imported row and quota charge', async () => {
  const f = await table();
  const before = (await store.list(scope())).quotas.storedBytes;
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    key: index === 999 ? 'row_0' : `row_${String(index)}`,
    amount: index,
  }));
  await expect(
    store.importRows({
      ...scope(),
      tableId: f.id,
      idempotencyKey: randomUUID(),
      rows,
    }),
  ).rejects.toMatchObject({ code: 'key_conflict' });
  expect((await store.find({ ...scope(), tableId: f.id, query })).rows).toEqual(
    [],
  );
  const after = await store.list(scope());
  expect(after.tables.find((item) => item.id === f.id)?.rowCount).toBe(0);
  expect(after.quotas.storedBytes).toBe(before);
});

it('checks live membership and scopes identical table names and raw RLS to their workspace', async () => {
  const f = await table();
  await insert(f, 'private');
  const raw = await withTenantScopedReadClient(
    apiPool,
    { workspaceId: otherWorkspaceId },
    (client) =>
      client.query(
        'select id from app.workspace_data_table_rows where table_id=$1',
        [f.id],
      ),
  );
  expect(raw.rows).toHaveLength(0);
  await expect(
    store.find({
      workspaceId: otherWorkspaceId,
      actorId: otherActorId,
      tableId: f.id,
      query,
    }),
  ).rejects.toMatchObject({ code: 'not_found' });
  await expect(
    store.list({ workspaceId, actorId: otherActorId }),
  ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  const viewer = randomUUID();
  await identity.createUser({
    id: viewer,
    email: `${viewer}@example.test`,
    displayName: 'Viewer',
  });
  await queryAsOwner(
    "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'viewer','active')",
    [workspaceId, viewer],
    workspaceId,
  );
  expect(
    (await store.list({ workspaceId, actorId: viewer })).tables.some(
      (item) => item.id === f.id,
    ),
  ).toBe(true);
  await expect(
    store.create({
      workspaceId,
      actorId: viewer,
      name: 'Forbidden',
      columns,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
});

it('enforces a race-safe row quota and refuses each limit below current use', async () => {
  const isolated = await identity.createWorkspaceWithOwner({
    id: randomUUID(),
    name: 'Table quotas',
    slug: `tables-${randomUUID()}`,
    ownerUserId: actorId,
    idempotencyKey: randomUUID(),
  });
  const s = { workspaceId: isolated.id, actorId };
  await store.configure({
    ...s,
    idempotencyKey: randomUUID(),
    tableLimit: 2,
    columnLimit: 5,
    rowLimit: 1,
    byteLimit: 65536,
  });
  const f = await store.create({
    ...s,
    idempotencyKey: randomUUID(),
    name: 'Bounded',
    columns,
    keyColumn: 'key',
  });
  const results = await Promise.allSettled(
    ['a', 'b'].map((key) =>
      store.write({
        ...s,
        tableId: f.id,
        idempotencyKey: randomUUID(),
        command: {
          operation: 'insert',
          table: 'Bounded',
          values: { key, amount: 1 },
        },
      }),
    ),
  );
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(
    results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    ),
  ).toEqual([expect.objectContaining({ code: 'quota_exceeded' })]);
  const list = await store.list(s);
  expect(list.tables[0]?.rowCount).toBe(1);
  expect(list.quotas.storedBytes).toBeGreaterThan(0);
  const inUse = {
    tableLimit: 2,
    columnLimit: columns.length,
    rowLimit: 2,
    byteLimit: 65536,
  };
  await store.configure({ ...s, idempotencyKey: randomUUID(), ...inUse });
  await store.write({
    ...s,
    tableId: f.id,
    idempotencyKey: randomUUID(),
    command: {
      operation: 'insert',
      table: 'Bounded',
      values: { key: 'c', amount: 1 },
    },
  });
  await store.create({
    ...s,
    idempotencyKey: randomUUID(),
    name: 'Second',
    columns,
  });
  for (const below of [
    { tableLimit: 1 },
    { columnLimit: columns.length - 1 },
    { rowLimit: 1 },
  ])
    await expect(
      store.configure({
        ...s,
        idempotencyKey: randomUUID(),
        ...inUse,
        ...below,
      }),
      JSON.stringify(below),
    ).rejects.toMatchObject({ code: 'quota_exceeded' });
  await expect(
    store.configure({ ...s, idempotencyKey: randomUUID(), ...inUse }),
  ).resolves.toMatchObject(inUse);
  await purgeTestWorkspace(isolated.id);
  const retained = await queryAsOwner(
    'select id from app.workspace_data_tables where workspace_id=$1',
    [isolated.id],
    isolated.id,
  );
  expect(retained).toHaveLength(0);
}, 30_000);

it('refuses stale table deletion and updates accounting after explicit removal', async () => {
  const f = await table();
  const old = required(
    (await store.list(scope())).tables.find((item) => item.id === f.id),
  );
  await insert(f, 'a');
  await expect(
    store.remove({
      ...scope(),
      tableId: f.id,
      expectedRevision: old.revision,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
  const current = required(
    (await store.list(scope())).tables.find((item) => item.id === f.id),
  );
  await store.remove({
    ...scope(),
    tableId: f.id,
    expectedRevision: current.revision,
    idempotencyKey: randomUUID(),
  });
  await expect(
    store.find({ ...scope(), tableId: f.id, query }),
  ).rejects.toMatchObject({ code: 'not_found' });
});
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
  expect(rows.map(({ revision, values }) => ({ revision, values }))).toEqual(
    expect.arrayContaining([
      { revision: 2, values: { key: 'a', amount: 1, active: false } },
      { revision: 2, values: { key: 'b', amount: 2, active: false } },
      { revision: 1, values: { key: 'c', amount: 3, active: true } },
    ]),
  );
  expect(rows).toHaveLength(3);
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
