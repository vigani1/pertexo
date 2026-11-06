import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  afterAllFixture2,
  beforeAllFixture1,
  query,
  store,
} from './table-records.fixture.js';
import { randomUUID, createHash } from 'node:crypto';
import {
  insertOrder,
  newWorkspace,
  ordersTable,
  snapshot,
  orderColumns,
  revisionOf,
  addMember,
  exportCsv,
  type Actor,
} from './table-rules.fixture.js';
import { canonicalJson } from '@pertexo/workflow-model';
import {
  IdempotencyConflictError,
  queryAsOwner,
} from '../support/workflow-authoring.js';
import type { Role } from '@pertexo/policy';
import { WorkspaceAccessDeniedError } from '../../src/shared/workspace-access.errors.js';
import { dataTableNewColumnsSchema } from '@pertexo/node-sdk';

const onKey = (value: string) => ({
  ...query,
  filters: [{ column: 'key', operator: 'equals' as const, value }],
});

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

const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

/** A completed receipt exactly as the code before this pass stored it. */
async function seedReceipt(
  actor: Actor,
  receipt: Readonly<{
    operation: string;
    key: string;
    request: unknown;
    result: unknown;
  }>,
) {
  await queryAsOwner(
    `insert into app.idempotency_records(
       id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref
     ) values($1,$2,$3,$4,$5,$6,'completed',$2,$7::jsonb)`,
    [
      randomUUID(),
      actor.workspaceId,
      receipt.operation,
      actor.actorId,
      sha256(receipt.key),
      sha256(canonicalJson(receipt.request)),
      JSON.stringify(receipt.result),
    ],
    actor.workspaceId,
  );
}

type Context = Readonly<{
  actor: Actor;
  table: Readonly<{ id: string; name: string }>;
  revision: number;
  rowId: string;
}>;

type Retry = Readonly<{
  name: string;
  operation: string;
  /** What this write hashed before the pass. */
  request: (context: Context) => unknown;
  send: (context: Context, idempotencyKey: string) => Promise<unknown>;
  /** The same write under the same key, asking for something else. */
  changed: (context: Context, idempotencyKey: string) => Promise<unknown>;
}>;

const LIMITS = {
  tableLimit: 30,
  columnLimit: 30,
  rowLimit: 5000,
  byteLimit: 1_048_576,
};

const insertCommand = (table: Context['table']) => ({
  operation: 'insert' as const,
  table: table.name,
  values: { key: 'z', amount: 1, active: true },
});

const updateCommand = (table: Context['table']) => ({
  operation: 'update' as const,
  table: table.name,
  query,
  values: { amount: 5 },
});

const RETRIES: readonly Retry[] = [
  {
    name: 'a row write',
    operation: 'data.tables.rows.write',
    request: ({ table }) => ({
      tableId: table.id,
      command: insertCommand(table),
      rowId: null,
      expectedRevision: null,
    }),
    send: ({ actor, table }, idempotencyKey) =>
      store.write({
        ...actor,
        tableId: table.id,
        idempotencyKey,
        command: insertCommand(table),
      }),
    changed: ({ actor, table }, idempotencyKey) =>
      store.write({
        ...actor,
        tableId: table.id,
        idempotencyKey,
        command: {
          ...insertCommand(table),
          values: { key: 'z', amount: 2, active: true },
        },
      }),
  },
  {
    name: 'a named-row edit',
    operation: 'data.tables.rows.write',
    request: ({ table, rowId }) => ({
      tableId: table.id,
      command: updateCommand(table),
      rowId,
      expectedRevision: 1,
    }),
    send: ({ actor, table, rowId }, idempotencyKey) =>
      store.write({
        ...actor,
        tableId: table.id,
        idempotencyKey,
        rowId,
        expectedRevision: 1,
        command: updateCommand(table),
      }),
    changed: ({ actor, table, rowId }, idempotencyKey) =>
      store.write({
        ...actor,
        tableId: table.id,
        idempotencyKey,
        rowId,
        expectedRevision: 2,
        command: updateCommand(table),
      }),
  },
  {
    name: 'a row import',
    operation: 'data.tables.rows.import',
    request: ({ table }) => ({ tableId: table.id, rows: [{ key: 'y' }] }),
    send: ({ actor, table }, idempotencyKey) =>
      store.importRows({
        ...actor,
        tableId: table.id,
        idempotencyKey,
        rows: [{ key: 'y' }],
      }),
    changed: ({ actor, table }, idempotencyKey) =>
      store.importRows({
        ...actor,
        tableId: table.id,
        idempotencyKey,
        rows: [{ key: 'other' }],
      }),
  },
  {
    name: 'a CSV import',
    operation: 'data.tables.rows.import',
    request: ({ table }) => ({ tableId: table.id, csv: 'key\ny\n' }),
    send: ({ actor, table }, idempotencyKey) =>
      store.importRows({
        ...actor,
        tableId: table.id,
        idempotencyKey,
        csv: 'key\ny\n',
        prepareRows: () => [{ key: 'y' }],
      }),
    changed: ({ actor, table }, idempotencyKey) =>
      store.importRows({
        ...actor,
        tableId: table.id,
        idempotencyKey,
        csv: 'key\nother\n',
        prepareRows: () => [{ key: 'other' }],
      }),
  },
  {
    name: 'a table creation',
    operation: 'data.tables.create',
    request: () => ({
      name: 'Retried',
      columns: orderColumns,
      keyColumn: 'key',
    }),
    send: ({ actor }, idempotencyKey) =>
      store.create({
        ...actor,
        idempotencyKey,
        name: 'Retried',
        columns: orderColumns,
        keyColumn: 'key',
      }),
    changed: ({ actor }, idempotencyKey) =>
      store.create({
        ...actor,
        idempotencyKey,
        name: 'Retried',
        columns: orderColumns,
        keyColumn: null,
      }),
  },
  {
    name: 'a schema edit',
    operation: 'data.tables.schema.edit',
    request: ({ table, revision }) => ({
      tableId: table.id,
      expectedRevision: revision,
      change: { operation: 'set_key', columnId: null },
    }),
    send: ({ actor, table, revision }, idempotencyKey) =>
      store.editSchema({
        ...actor,
        tableId: table.id,
        expectedRevision: revision,
        idempotencyKey,
        change: { operation: 'set_key', columnId: null },
      }),
    changed: ({ actor, table, revision }, idempotencyKey) =>
      store.editSchema({
        ...actor,
        tableId: table.id,
        expectedRevision: revision,
        idempotencyKey,
        change: { operation: 'set_key', columnId: 'amount' },
      }),
  },
  {
    name: 'a table removal',
    operation: 'data.tables.remove',
    request: ({ table, revision }) => ({
      tableId: table.id,
      expectedRevision: revision,
    }),
    send: ({ actor, table, revision }, idempotencyKey) =>
      store.remove({
        ...actor,
        tableId: table.id,
        expectedRevision: revision,
        idempotencyKey,
      }),
    changed: ({ actor, table, revision }, idempotencyKey) =>
      store.remove({
        ...actor,
        tableId: table.id,
        expectedRevision: revision + 1,
        idempotencyKey,
      }),
  },
  {
    name: 'a limit change',
    operation: 'data.tables.configure',
    request: () => LIMITS,
    send: ({ actor }, idempotencyKey) =>
      store.configure({ ...actor, idempotencyKey, ...LIMITS }),
    changed: ({ actor }, idempotencyKey) =>
      store.configure({
        ...actor,
        idempotencyKey,
        ...LIMITS,
        rowLimit: LIMITS.rowLimit + 1,
      }),
  },
];

async function context(): Promise<Context> {
  const actor = await newWorkspace();
  const table = await ordersTable(actor, 'key');
  const inserted = await insertOrder(actor, table, 'a');
  const rowId = inserted.rows[0]?.id;
  if (rowId === undefined) throw new Error('Row missing');
  return {
    actor,
    table,
    rowId,
    revision: await revisionOf(actor, table.id),
  };
}

type Table = Readonly<{ id: string; name: string }>;

const LIMITS2 = {
  tableLimit: 25,
  columnLimit: 25,
  rowLimit: 2000,
  byteLimit: 1_048_576,
};

/** Every table change a member can ask for, keyed so a refusal names which one. */
export function changes(actor: Actor, owner: Actor, table: Table) {
  const once = () => ({ ...actor, idempotencyKey: randomUUID() });
  return {
    create: () =>
      store.create({
        ...once(),
        name: `New_${randomUUID().replaceAll('-', '')}`,
        columns: orderColumns,
        keyColumn: null,
      }),
    write: () =>
      store.write({
        ...once(),
        tableId: table.id,
        command: {
          operation: 'insert',
          table: table.name,
          values: { key: randomUUID(), amount: 1 },
        },
      }),
    importRows: () =>
      store.importRows({
        ...once(),
        tableId: table.id,
        rows: [{ key: randomUUID(), amount: 1 }],
      }),
    editSchema: async () =>
      store.editSchema({
        ...once(),
        tableId: table.id,
        expectedRevision: await revisionOf(owner, table.id),
        change: {
          operation: 'rename_column',
          columnId: 'amount',
          name: `amount_${randomUUID().slice(0, 8)}`,
        },
      }),
  };
}

async function worldWithRow() {
  const owner = await newWorkspace();
  const table = await ordersTable(owner, 'key');
  await insertOrder(owner, table, 'seen', 3);
  return { owner, table };
}

/** What every member of a workspace can see of a table with one row, `seen`. */
export async function expectReadsShowTheRow(actor: Actor, table: Table) {
  const { tables } = await store.list(actor);
  expect(tables.find(({ id }) => id === table.id)).toMatchObject({
    name: table.name,
    rowCount: 1,
  });
  const found = await store.find({
    ...actor,
    tableId: table.id,
    query: { filters: [], limit: 10, offset: 0 },
  });
  expect(found.rows.map(({ values }) => values)).toEqual([
    { key: 'seen', amount: 3, active: true },
  ]);
  const csv = await exportCsv(actor, table.id);
  expect(csv).toContain('seen');
}

async function expectReadsRefused(actor: Actor, table: Table) {
  await expect(store.list(actor)).rejects.toBeInstanceOf(
    WorkspaceAccessDeniedError,
  );
  await expect(
    store.find({
      ...actor,
      tableId: table.id,
      query: { filters: [], limit: 10, offset: 0 },
    }),
  ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  await expect(exportCsv(actor, table.id)).rejects.toBeInstanceOf(
    WorkspaceAccessDeniedError,
  );
}

async function expectChangesRefused(actor: Actor, owner: Actor, table: Table) {
  const before = await snapshot(owner, table.id);
  for (const [name, change] of Object.entries(changes(actor, owner, table)))
    await expect(change(), name).rejects.toBeInstanceOf(
      WorkspaceAccessDeniedError,
    );
  await expect(
    store.configure({
      ...actor,
      idempotencyKey: randomUUID(),
      ...LIMITS2,
    }),
  ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  await expect(
    store.remove({
      ...actor,
      idempotencyKey: randomUUID(),
      tableId: table.id,
      expectedRevision: await revisionOf(owner, table.id),
    }),
  ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  expect(await snapshot(owner, table.id)).toEqual(before);
}

const ROLE_CASES: readonly [Role, boolean, boolean][] = [
  ['owner', true, true],
  ['admin', true, true],
  ['builder', true, false],
  ['operator', false, false],
  ['viewer', false, false],
];

function setStatus(
  workspaceId: string,
  status: 'suspended' | 'pending_deletion' | 'purging',
  actorId: string,
) {
  return queryAsOwner(
    `update app.workspaces set status=$2::text,
       deletion_requested_at=case when $2::text<>'suspended' then clock_timestamp() end,
       deletion_requested_by=case when $2::text<>'suspended' then $3::uuid end,
       deletion_reason=case when $2::text<>'suspended' then 'data table state proof' end,
       purge_after=case when $2::text<>'suspended' then clock_timestamp()+interval '1 day' end
     where id=$1`,
    [workspaceId, status, actorId],
    workspaceId,
  );
}

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

const ELIGIBLE = [
  ['text', 'a'],
  ['number', 7],
  ['date', '2026-01-02'],
] as const;

const INELIGIBLE = [
  ['a required boolean', { type: 'boolean', required: true }],
  ['a required JSON', { type: 'json', required: true }],
  ['an optional text', { type: 'text', required: false }],
  ['an optional number', { type: 'number', required: false }],
  ['an optional date', { type: 'date', required: false }],
] as const;

const keyRefused = {
  code: 'invalid_values',
  message: 'The unique key must be a required text, number or date column.',
};

function create(
  actor: Actor,
  column: Readonly<{ type: string; required: boolean }>,
  keyColumn: string | null,
) {
  return store.create({
    ...actor,
    idempotencyKey: randomUUID(),
    name: `Keyed_${randomUUID().replaceAll('-', '')}`,
    columns: dataTableNewColumnsSchema.parse([
      { name: 'candidate', ...column },
      { name: 'other', type: 'text' },
    ]),
    keyColumn,
  });
}

beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
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
  const upsert = (values: { key: string; amount: number; active?: boolean }) =>
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
it.each(RETRIES.map((retry) => [retry.name, retry] as const))(
  'answers a retry of %s from before the pass with its stored result, doing nothing',
  async (_name, retry) => {
    const world = await context();
    const key = randomUUID();
    const result = { pertexoStoredReceipt: true, affected: 7 };
    await seedReceipt(world.actor, {
      operation: retry.operation,
      key,
      request: retry.request(world),
      result,
    });
    const before = await snapshot(world.actor, world.table.id);

    await expect(retry.send(world, key)).resolves.toEqual(result);

    expect(await snapshot(world.actor, world.table.id)).toEqual(before);
  },
);

it.each(RETRIES.map((retry) => [retry.name, retry] as const))(
  'refuses %s with a used key and a different request, doing nothing',
  async (_name, retry) => {
    const world = await context();
    const key = randomUUID();
    await seedReceipt(world.actor, {
      operation: retry.operation,
      key,
      request: retry.request(world),
      result: { affected: 7 },
    });
    const before = await snapshot(world.actor, world.table.id);

    await expect(retry.changed(world, key)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );

    expect(await snapshot(world.actor, world.table.id)).toEqual(before);
  },
);

it('stores a new write under the same hash an older retry would send', async () => {
  const world = await context();
  const key = randomUUID();
  const send = () =>
    store.write({
      ...world.actor,
      tableId: world.table.id,
      idempotencyKey: key,
      command: insertCommand(world.table),
    });
  const first = await send();
  const before = await snapshot(world.actor, world.table.id);
  await expect(send()).resolves.toEqual(first);
  expect(await snapshot(world.actor, world.table.id)).toEqual(before);

  const stored = await queryAsOwner<{ request_hash: string }>(
    `select request_hash from app.idempotency_records
       where workspace_id=$1 and operation='data.tables.rows.write' and key_hash=$2`,
    [world.actor.workspaceId, sha256(key)],
    world.actor.workspaceId,
  );
  expect(stored).toEqual([
    {
      request_hash: sha256(
        canonicalJson({
          tableId: world.table.id,
          command: insertCommand(world.table),
          rowId: null,
          expectedRevision: null,
        }),
      ),
    },
  ]);
});
it.each(ROLE_CASES)(
  'as %s: reads hold, edits rows and schema: %s, changes limits: %s',
  async (role, canEdit, canConfigure) => {
    const { owner, table } = await worldWithRow();
    // A workspace has exactly one owner.
    const member =
      role === 'owner' ? owner : await addMember(owner.workspaceId, role);

    await expectReadsShowTheRow(member, table);

    const before = await snapshot(owner, table.id);
    for (const [name, change] of Object.entries(
      changes(member, owner, table),
    )) {
      if (canEdit) await expect(change(), name).resolves.toBeDefined();
      else
        await expect(change(), name).rejects.toBeInstanceOf(
          WorkspaceAccessDeniedError,
        );
    }
    if (!canEdit) expect(await snapshot(owner, table.id)).toEqual(before);

    const limits = store.configure({
      ...member,
      idempotencyKey: randomUUID(),
      ...LIMITS2,
    });
    if (canConfigure) {
      await expect(limits).resolves.toMatchObject(LIMITS2);
      expect((await store.list(owner)).quotas).toMatchObject(LIMITS2);
    } else {
      await expect(limits).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
      expect((await store.list(owner)).quotas.rowLimit).not.toBe(
        LIMITS2.rowLimit,
      );
    }

    const removal = store.remove({
      ...member,
      idempotencyKey: randomUUID(),
      tableId: table.id,
      expectedRevision: await revisionOf(owner, table.id),
    });
    if (canEdit) await expect(removal).resolves.toEqual({ removed: true });
    else
      await expect(removal).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  },
);

it.each(['removed', 'suspended'] as const)(
  'lets a %s member neither read nor write',
  async (status) => {
    const { owner, table } = await worldWithRow();
    const member = await addMember(owner.workspaceId, 'builder', status);
    await expectReadsRefused(member, table);
    await expectChangesRefused(member, owner, table);
  },
);

it('lets someone who never joined neither read nor write', async () => {
  const { owner, table } = await worldWithRow();
  const other = await newWorkspace();
  const stranger = await addMember(other.workspaceId, 'admin');
  const outsider = {
    workspaceId: owner.workspaceId,
    actorId: stranger.actorId,
  };
  await expectReadsRefused(outsider, table);
  await expectChangesRefused(outsider, owner, table);
});
it.each(['suspended', 'pending_deletion'] as const)(
  'keeps table reads open while %s, for an owner and a viewer, and refuses every change',
  async (status) => {
    const { owner, table } = await worldWithRow();
    const viewer = await addMember(owner.workspaceId, 'viewer');
    const builder = await addMember(owner.workspaceId, 'builder');
    await setStatus(owner.workspaceId, status, owner.actorId);

    await expectReadsShowTheRow(owner, table);
    await expectReadsShowTheRow(viewer, table);
    await expectChangesRefused(owner, owner, table);
    await expectChangesRefused(builder, owner, table);
  },
);

it('closes table reads once the purge has started', async () => {
  const { owner, table } = await worldWithRow();
  await setStatus(owner.workspaceId, 'purging', owner.actorId);
  await expectReadsRefused(owner, table);
});
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
    columns: dataTableNewColumnsSchema.parse([{ name: 'note', type: 'text' }]),
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
it.each(ELIGIBLE)(
  'takes a required %s column as a unique key, at creation and later, and keys rows on it',
  async (type, value) => {
    const actor = await newWorkspace();
    const created = await create(actor, { type, required: true }, 'candidate');
    const later = await create(actor, { type, required: true }, null);
    await store.editSchema({
      ...actor,
      tableId: later.id,
      idempotencyKey: randomUUID(),
      expectedRevision: await revisionOf(actor, later.id),
      change: { operation: 'set_key', columnId: 'candidate' },
    });
    const { tables } = await store.list(actor);
    for (const { id } of [created, later]) {
      const table = tables.find((item) => item.id === id);
      if (table === undefined) throw new Error('Table missing');
      expect(table.keyColumn).toBe('candidate');
      const upsert = (other: string) =>
        store.write({
          ...actor,
          tableId: id,
          idempotencyKey: randomUUID(),
          command: {
            operation: 'upsert',
            table: table.name,
            values: { candidate: value, other },
          },
        });
      await upsert('first');
      await upsert('second');
      const { rows } = await store.find({
        ...actor,
        tableId: id,
        query: { filters: [], limit: 10, offset: 0 },
      });
      expect(rows.map((row) => row.values.other)).toEqual(['second']);
    }
  },
);

it.each(INELIGIBLE)(
  'refuses %s column as a unique key, at creation and later, and changes nothing',
  async (_name, column) => {
    const actor = await newWorkspace();
    await expect(create(actor, column, 'candidate')).rejects.toMatchObject(
      keyRefused,
    );
    expect((await store.list(actor)).quotas.tableCount).toBe(0);

    const later = await create(actor, column, null);
    await expect(
      store.editSchema({
        ...actor,
        tableId: later.id,
        idempotencyKey: randomUUID(),
        expectedRevision: await revisionOf(actor, later.id),
        change: { operation: 'set_key', columnId: 'candidate' },
      }),
    ).rejects.toMatchObject(keyRefused);
    const table = (await store.list(actor)).tables.find(
      ({ id }) => id === later.id,
    );
    expect(table?.keyColumn).toBeNull();
  },
);
