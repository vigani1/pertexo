import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { DataTableSchemaChange } from '@pertexo/contracts';
import type { DataTableQuery } from '@pertexo/node-sdk';
import { createDataTablesStore } from '../../src/data-tables/index.js';
import { parseDatabaseConfig } from '../../src/config.js';
import {
  apiUrl,
  actorId,
  otherActorId,
  workspaceId,
  queryAsOwner,
  apiPool,
  workflowId,
} from '../support/workflow-authoring.js';
import { withTenantScopedReadClient } from '../../src/tenant-access/transactions.js';
import { requireTable } from '../../src/data-tables/read.js';
import { exportTableCsv } from '../../src/data-tables/csv/export.js';
import {
  withWorkspaceTransaction,
  withTenantScopedClient,
} from '../../src/tenant-access/transactions.js';
import {
  dataTableReferenceIssues,
  requireRunTableReferences,
} from '../../src/data-tables/columns/references.js';
import type { WorkflowGraph } from '@pertexo/workflow-model';

let store: ReturnType<typeof createDataTablesStore>;
beforeAll(() => {
  store = createDataTablesStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 6 }),
  );
});
afterAll(() => store.close());
const scope = () => ({ workspaceId, actorId });
const all: DataTableQuery = { filters: [], limit: 100, offset: 0 };
async function create() {
  const name = `Columns_${randomUUID().replaceAll('-', '')}`;
  const { id } = await store.create({
    ...scope(),
    idempotencyKey: randomUUID(),
    name,
    keyColumn: 'key',
    columns: [
      { name: 'key', type: 'text', required: true },
      { name: 'amount', type: 'number', required: true },
      { name: 'note', type: 'text', required: false },
    ],
  });
  return { id, name };
}
async function current(id: string) {
  const table = (await store.list(scope())).tables.find(
    (table) => table.id === id,
  );
  if (table === undefined) throw new Error('Table missing');
  return table;
}
async function edit(id: string, change: DataTableSchemaChange) {
  return store.editSchema({
    ...scope(),
    tableId: id,
    expectedRevision: (await current(id)).revision,
    change,
    idempotencyKey: randomUUID(),
  });
}
async function rows(id: string) {
  return (await store.find({ ...scope(), tableId: id, query: all })).rows;
}

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
  ).rejects.toThrow('required');
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
  expect((await rows(table.id)).every((row) => row.values.flag === false)).toBe(
    true,
  );
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
  expect((await rows(table.id)).every((row) => row.values.flag === null)).toBe(
    true,
  );
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
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(
    1,
  );
  await expect(
    store.editSchema({
      ...scope(),
      actorId: otherActorId,
      tableId: table.id,
      expectedRevision: (await current(table.id)).revision,
      change: { operation: 'set_key', columnId: null },
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toThrow();
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

it('exports beyond page one and the entire filtered/sorted result with formula escaping', async () => {
  const table = await create();
  await store.importRows({
    ...scope(),
    tableId: table.id,
    idempotencyKey: randomUUID(),
    rows: Array.from({ length: 120 }, (_, amount) => ({
      key: `row${String(amount)}`,
      amount,
      note: amount === 119 ? '=SUM(A1:A2)' : 'plain',
    })),
  });
  const exported = await store.exportCsv({
    ...scope(),
    tableId: table.id,
    query: { filters: [], sort: { column: 'amount', direction: 'asc' } },
  });
  expect(exported.rowCount).toBe(120);
  expect(exported.csv.split('\r\n')).toHaveLength(121);
  expect(exported.csv).toContain('"row119","119","\'=SUM(A1:A2)"');
  const filtered = await store.exportCsv({
    ...scope(),
    tableId: table.id,
    query: {
      filters: [{ column: 'amount', operator: 'greater_than', value: 60 }],
      sort: { column: 'amount', direction: 'desc' },
    },
  });
  expect(filtered.rowCount).toBe(59);
  expect(filtered.csv.split('\r\n')[1]).toContain('row119');
  expect(filtered.csv.split('\r\n').at(-1)).toContain('row61');
});

it('claims raw CSV before conversion so a committed import replays after a schema change', async () => {
  const table = await create();
  let conversions = 0;
  const input = {
    ...scope(),
    tableId: table.id,
    idempotencyKey: randomUUID(),
    csv: 'key,amount,note\na,1,',
    prepareRows: () => {
      conversions += 1;
      return [{ key: 'a', amount: 1, note: null }];
    },
  };
  const result = await store.importRows(input);
  await edit(table.id, {
    operation: 'rename_column',
    columnId: 'amount',
    name: 'total',
  });
  expect(await store.importRows(input)).toEqual(result);
  expect(conversions).toBe(1);
  expect((await rows(table.id))[0]?.values).toEqual({
    key: 'a',
    total: 1,
    note: null,
  });
  await expect(
    store.importRows({ ...input, csv: 'key,amount,note\nb,2,' }),
  ).rejects.toThrow('Idempotency');
});

it('refuses an oversized complete CSV after counting UTF-8 and quoting', async () => {
  const table = await create();
  await store.importRows({
    ...scope(),
    tableId: table.id,
    idempotencyKey: randomUUID(),
    rows: Array.from({ length: 25 }, (_, amount) => ({
      key: `row${String(amount)}`,
      amount,
      note: 'é"'.repeat(15000),
    })),
  });
  await expect(
    store.exportCsv({ ...scope(), tableId: table.id, query: { filters: [] } }),
  ).rejects.toThrow('complete CSV exceeds 1 MB');
  const filtered = await store.exportCsv({
    ...scope(),
    tableId: table.id,
    query: { filters: [{ column: 'amount', operator: 'less_than', value: 2 }] },
  });
  expect(filtered.rowCount).toBe(2);
});

it('exports one schema/data snapshot while a concurrent rename commits', async () => {
  const table = await create();
  await store.importRows({
    ...scope(),
    tableId: table.id,
    idempotencyKey: randomUUID(),
    rows: [{ key: 'a', amount: 2 }],
  });
  const exported = await withTenantScopedReadClient(
    apiPool,
    scope(),
    async (client) => {
      const snapshot = await requireTable(client, workspaceId, {
        id: table.id,
      });
      await edit(table.id, {
        operation: 'rename_column',
        columnId: 'amount',
        name: 'total',
      });
      return exportTableCsv(client, workspaceId, snapshot, { filters: [] });
    },
  );
  expect(exported.csv).toContain('"key","amount","note"');
  expect(exported.csv).toContain('"a","2",""');
  expect((await current(table.id)).columns[1]?.name).toBe('total');
});

it('enforces a new valid unique key and rolls back a later duplicate write', async () => {
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
  await edit(table.id, { operation: 'set_key', columnId: 'amount' });
  expect((await current(table.id)).keyColumn).toBe('amount');
  await expect(
    store.importRows({
      ...scope(),
      tableId: table.id,
      idempotencyKey: randomUUID(),
      rows: [{ key: 'c', amount: 2 }],
    }),
  ).rejects.toMatchObject({ code: 'key_conflict' });
  expect((await current(table.id)).rowCount).toBe(2);
});

it('checks singleton/multiple table bindings before published starts, including nested bodies', async () => {
  const first = await create(),
    second = await create();
  const step = (id: string, table: string) => ({
    id,
    definition: { key: 'core.table_find', version: 1 },
    configVersion: 1,
    config: { table, columnBindings: { amount: 'amount' } },
    inputMappings: {},
    connectionRefs: {},
    position: { x: 0, y: 0 },
  });
  const graph: WorkflowGraph = {
    nodes: [
      step('first', first.name),
      {
        id: 'loop',
        definition: { key: 'core.for_each', version: 1 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
        position: { x: 0, y: 0 },
        structured: {
          kind: 'for_each',
          maxIterations: 1,
          maxConcurrency: 1,
          body: {
            settings: {},
            nodes: [step('nested', second.name)],
            edges: [],
            inputPorts: ['in'],
            outputPorts: ['out'],
          },
        },
      },
    ],
    edges: [],
    settings: {},
  };
  const version = randomUUID();
  await queryAsOwner(
    'insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by) select $1,$2,$3,coalesce(max(version_number),0)+1,$4::jsonb,$5::jsonb,$6,$7 from app.workflow_versions where workflow_id=$3',
    [
      version,
      workspaceId,
      workflowId,
      JSON.stringify(graph),
      JSON.stringify({ graph }),
      `wf:sha256:${'b'.repeat(64)}`,
      actorId,
    ],
    workspaceId,
  );
  const check = () =>
    withWorkspaceTransaction(apiPool, workspaceId, (transaction) =>
      requireRunTableReferences(transaction, version),
    );
  await check();
  await edit(first.id, {
    operation: 'rename_column',
    columnId: 'amount',
    name: 'total',
  });
  await check();
  await edit(second.id, {
    operation: 'remove_column',
    columnId: 'amount',
    confirm: true,
  });
  await expect(check()).rejects.toThrow('Mapped column amount');
  const issues = await withTenantScopedClient(apiPool, scope(), (client) =>
    dataTableReferenceIssues(client, workspaceId, graph),
  );
  expect(issues).toHaveLength(1);
  expect(issues[0]?.path).toContain('structured.body');
});

it('changes all 100,000 rows within the existing bounds with exact counters', async () => {
  const table = await create();
  await store.configure({
    ...scope(),
    tableLimit: 20,
    columnLimit: 20,
    rowLimit: 100000,
    byteLimit: 52428800,
    idempotencyKey: randomUUID(),
  });
  for (let offset = 0; offset < 100000; offset += 1000)
    await store.importRows({
      ...scope(),
      tableId: table.id,
      idempotencyKey: randomUUID(),
      rows: Array.from({ length: 1000 }, (_, index) => ({
        key: `r${String(offset + index)}`,
        amount: offset + index,
      })),
    });
  const started = performance.now();
  await edit(table.id, {
    operation: 'rename_column',
    columnId: 'amount',
    name: 'total',
  });
  const renameMillis = performance.now() - started;
  const facts = await queryAsOwner<{
    count: number;
    bytes: string;
    changed: number;
  }>(
    "select count(*)::int count,sum(octet_length(values_json))::text bytes,count(*) filter(where values_json::jsonb ? 'total' and not values_json::jsonb ? 'amount')::int changed from app.workspace_data_table_rows where table_id=$1",
    [table.id],
  );
  const changed = await current(table.id);
  expect(facts[0]?.count).toBe(100000);
  expect(facts[0]?.changed).toBe(100000);
  expect(changed.storedBytes).toBe(Number(facts[0]?.bytes));
  process.stdout.write(
    `F14 schema maximum evidence ${JSON.stringify({ rows: changed.rowCount, renameMillis, storedBytes: changed.storedBytes })}\n`,
  );
}, 90000);
