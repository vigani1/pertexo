import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, it, expect } from 'vitest';
import {
  createDataTablesStore,
  createWorkerDataTablesStore,
} from '../../src/data-tables/index.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { markPreviewDispatched } from '../../src/previews/attempts/dispatch.repository.js';
import { completePreviewAttempt } from '../../src/previews/attempts/completion.repository.js';
import { createPreviewRetentionCoordinator } from '../../src/lifecycle/previews/repository.js';
import {
  actorUserId,
  workspaceId,
  apiPool,
  workerPool,
  acceptFixture,
  claimFixture,
  withAdmin,
  databaseUrl,
  maintenanceBaseUrl,
} from '../previews/worker.fixture.js';
let tables: ReturnType<typeof createDataTablesStore>,
  worker: ReturnType<typeof createWorkerDataTablesStore>;
beforeAll(() => {
  const connectionString = apiPool.options.connectionString;
  if (connectionString === undefined) throw new Error('Owned database missing');
  const config = parseDatabaseConfig({ connectionString, max: 4 });
  tables = createDataTablesStore(config);
  worker = createWorkerDataTablesStore(config);
});
afterAll(async () => {
  await tables.close();
  await worker.close();
});
const signal = new AbortController().signal;
async function fixture() {
  const table = await tables.create({
    workspaceId,
    actorId: actorUserId,
    idempotencyKey: randomUUID(),
    name: `Preview_${randomUUID().replaceAll('-', '')}`,
    columns: [
      { name: 'key', type: 'text', required: true },
      { name: 'amount', type: 'number', required: true },
    ],
    keyColumn: 'key',
  });
  const claimed = await claimFixture(
    await acceptFixture({
      sideEffectClass: 'idempotent_with_key',
      providerIdempotencyKey: randomUUID(),
      mayContactProvider: false,
      mayCauseExternalSideEffect: true,
    }),
    `table-preview-${randomUUID()}`,
  );
  const input = {
    workspaceId,
    runId: claimed.lease.previewRunId,
    previewRunId: claimed.lease.previewRunId,
    nodeRunId: claimed.lease.previewRunId,
    attemptId: claimed.lease.previewAttemptId,
    attemptNumber: 1,
    workerId: claimed.workerId,
    fenceToken: claimed.lease.attemptFenceToken,
    nodeId: claimed.lease.nodeId,
    invocationKey: `preview:${claimed.lease.nodeId}`,
    signal,
    command: {
      operation: 'insert' as const,
      table:
        (await tables.list({ workspaceId, actorId: actorUserId })).tables.find(
          (item) => item.id === table.id,
        )?.name ?? '',
      values: { key: 'a', amount: 1 },
    },
  };
  return { table, claimed, input };
}
it('requires dispatch authority and returns the exact receipt after row edits and table removal', async () => {
  const f = await fixture();
  await expect(worker.execute(f.input)).rejects.toMatchObject({
    code: 'attempt_expired',
  });
  await markPreviewDispatched(workerPool, {
    lease: f.claimed.lease,
    workerId: f.claimed.workerId,
  });
  const result = await worker.execute(f.input);
  expect(result.rows[0]?.values).toEqual({ key: 'a', amount: 1 });
  const row = result.rows[0];
  if (row === undefined) throw new Error('Inserted row missing');
  await tables.write({
    workspaceId,
    actorId: actorUserId,
    tableId: f.table.id,
    idempotencyKey: randomUUID(),
    rowId: row.id,
    expectedRevision: row.revision,
    command: {
      operation: 'update',
      table: f.input.command.table,
      query: { filters: [], limit: 100, offset: 0 },
      values: { amount: 99 },
    },
  });
  expect(await worker.execute(f.input)).toEqual(result);
  await expect(
    worker.execute({
      ...f.input,
      command: { ...f.input.command, values: { key: 'a', amount: 2 } },
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
  await expect(
    worker.execute({ ...f.input, fenceToken: f.input.fenceToken + 1 }),
  ).rejects.toMatchObject({ code: 'attempt_expired' });
  const current = (
    await tables.list({ workspaceId, actorId: actorUserId })
  ).tables.find((item) => item.id === f.table.id);
  if (current === undefined) throw new Error('Table missing');
  await tables.remove({
    workspaceId,
    actorId: actorUserId,
    tableId: f.table.id,
    expectedRevision: current.revision,
    idempotencyKey: randomUUID(),
  });
  expect(await worker.execute(f.input)).toEqual(result);
});

it('preserves scoped workflow aliases and receipts through renames and refuses deleted bindings', async () => {
  const f = await fixture();
  await markPreviewDispatched(workerPool, {
    lease: f.claimed.lease,
    workerId: f.claimed.workerId,
  });
  const input = {
    ...f.input,
    columnBindings: { key: 'key', amount: 'amount' },
  };
  const accepted = await worker.execute(input);
  for (const [columnId, name] of [
    ['key', 'order_key'],
    ['amount', 'total'],
  ] as const) {
    const table = (
      await tables.list({ workspaceId, actorId: actorUserId })
    ).tables.find((table) => table.id === f.table.id);
    if (table === undefined) throw new Error('Table missing');
    await tables.editSchema({
      workspaceId,
      actorId: actorUserId,
      tableId: table.id,
      expectedRevision: table.revision,
      change: { operation: 'rename_column', columnId, name },
      idempotencyKey: randomUUID(),
    });
  }
  const found = await worker.execute({
    ...input,
    command: {
      operation: 'find',
      table: input.command.table,
      query: {
        filters: [{ column: 'key', operator: 'equals', value: 'a' }],
        sort: { column: 'amount', direction: 'desc' },
        limit: 100,
        offset: 0,
      },
    },
  });
  expect(found.rows[0]?.values).toEqual({ key: 'a', amount: 1 });
  expect(await worker.execute(input)).toEqual(accepted);
  await expect(
    worker.execute({
      ...input,
      columnBindings: { key: 'amount', amount: 'key' },
    }),
  ).rejects.toMatchObject({ code: 'conflict' });
  const table = (
    await tables.list({ workspaceId, actorId: actorUserId })
  ).tables.find((table) => table.id === f.table.id);
  if (table === undefined) throw new Error('Table missing');
  await tables.editSchema({
    workspaceId,
    actorId: actorUserId,
    tableId: table.id,
    expectedRevision: table.revision,
    change: { operation: 'remove_column', columnId: 'amount', confirm: true },
    idempotencyKey: randomUUID(),
  });
  expect(await worker.execute(input)).toEqual(accepted);
  await expect(
    worker.execute({
      ...input,
      command: {
        operation: 'find',
        table: input.command.table,
        query: { filters: [], limit: 100, offset: 0 },
      },
    }),
  ).rejects.toThrow('removed');
  await expect(
    worker.execute({
      ...f.input,
      command: {
        operation: 'find',
        table: input.command.table,
        query: { filters: [], limit: 100, offset: 0 },
      },
    }),
  ).rejects.toThrow('legacy');
});
it('retains preview effects until preview retention and then cascades their private receipt', async () => {
  const f = await fixture();
  await markPreviewDispatched(workerPool, {
    lease: f.claimed.lease,
    workerId: f.claimed.workerId,
  });
  const result = await worker.execute(f.input);
  await completePreviewAttempt(workerPool, {
    delivery: f.claimed.fixture.delivery,
    lease: f.claimed.lease,
    workerId: f.claimed.workerId,
    outcome: { status: 'succeeded', output: { kind: 'inline', value: result } },
  });
  await withAdmin(async (admin) => {
    await admin.query(
      "update app.preview_runs set created_at=clock_timestamp()-interval '8 days',started_at=clock_timestamp()-interval '8 days'+interval '1 second',completed_at=clock_timestamp()-interval '8 days'+interval '2 seconds',execution_deadline_at=clock_timestamp()-interval '7 days',expires_at=clock_timestamp()-interval '6 days' where id=$1",
      [f.claimed.lease.previewRunId],
    );
  });
  const retention = createPreviewRetentionCoordinator(
    parseDatabaseConfig({
      connectionString: databaseUrl(maintenanceBaseUrl),
      max: 2,
    }),
    {
      delete: () => Promise.reject(new Error('No artifacts expected')),
      head: () => Promise.reject(new Error('No artifacts expected')),
    },
  );
  try {
    expect(await retention.processNext()).toMatchObject({
      status: 'completed',
      previewRunId: f.claimed.lease.previewRunId,
    });
  } finally {
    await retention.close();
  }
  await withAdmin(async (admin) => {
    expect(
      (
        await admin.query(
          'select 1 from app.data_table_write_receipts where execution_id=$1',
          [f.claimed.lease.previewRunId],
        )
      ).rows,
    ).toHaveLength(0);
  });
  expect(
    (
      await tables.find({
        workspaceId,
        actorId: actorUserId,
        tableId: f.table.id,
        query: { filters: [], limit: 100, offset: 0 },
      })
    ).rows,
  ).toHaveLength(1);
});
