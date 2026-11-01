import { createHash, randomUUID } from 'node:crypto';

import { canonicalJson } from '@pertexo/workflow-model';
import { expect, it } from 'vitest';

import {
  IdempotencyConflictError,
  queryAsOwner,
} from '../../support/workflow-authoring.js';
import { query, store } from '../records/fixture.js';
import {
  insertOrder,
  newWorkspace,
  orderColumns,
  ordersTable,
  revisionOf,
  snapshot,
  type Actor,
} from './world.js';

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

export function registerRetries(): void {
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
}
