import { withTenantScopedReadClient } from '../../src/tenant-access/transactions.js';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, it, expect } from 'vitest';
import {
  dataTableNewColumnsSchema,
  DataTableError,
  type DataTableQuery,
  type DataTableValues,
} from '@pertexo/node-sdk';
import { createDataTablesStore } from '../../src/data-tables/index.js';
import { parseDatabaseConfig } from '../../src/config.js';
import { WorkspaceAccessDeniedError } from '../../src/tenant-access/errors.js';
import {
  apiPool,
  apiUrl,
  actorId,
  otherActorId,
  workspaceId,
  otherWorkspaceId,
  identity,
  queryAsOwner,
  purgeTestWorkspace,
} from '../support/workflow-authoring.js';
let store: ReturnType<typeof createDataTablesStore>;
beforeAll(() => {
  store = createDataTablesStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 6 }),
  );
});
afterAll(() => store.close());
const scope = () => ({ workspaceId, actorId });
const columns = dataTableNewColumnsSchema.parse([
  { name: 'key', type: 'text', required: true },
  { name: 'amount', type: 'number' },
  { name: 'active', type: 'boolean' },
]);
const query: DataTableQuery = { filters: [], limit: 100, offset: 0 };
async function table() {
  const name = `Orders_${randomUUID().replaceAll('-', '')}`;
  const result = await store.create({
    ...scope(),
    name,
    columns,
    keyColumn: 'key',
    idempotencyKey: randomUUID(),
  });
  return { ...result, name };
}
async function insert(
  f: Awaited<ReturnType<typeof table>>,
  key: string,
  amount = 1,
) {
  return store.write({
    ...scope(),
    tableId: f.id,
    command: {
      operation: 'insert',
      table: f.name,
      values: { key, amount, active: true },
    },
    idempotencyKey: randomUUID(),
  });
}
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
  expect(result.rows[0]?.values).toEqual({ key: 'b', amount: 4, active: true });
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
it('enforces race-safe row and byte quotas and refuses limits below current use', async () => {
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
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(
    1,
  );
  const list = await store.list(s);
  expect(list.tables[0]?.rowCount).toBe(1);
  expect(list.quotas.storedBytes).toBeGreaterThan(0);
  await expect(
    store.configure({
      ...s,
      idempotencyKey: randomUUID(),
      tableLimit: 2,
      columnLimit: 2,
      rowLimit: 1,
      byteLimit: 65536,
    }),
  ).rejects.toBeInstanceOf(DataTableError);
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

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Fixture value missing');
  return value;
}

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
