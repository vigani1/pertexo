import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@pertexo/database/platform';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  createDataTablesStore,
  createWorkerDataTablesStore,
} from '../../src/data-tables/index.js';
import { markPreviewDispatched } from '../../src/previews/attempts/dispatch.repository.js';
import {
  acceptFixture,
  actorUserId,
  apiPool,
  claimFixture,
  withAdmin,
  workerPool,
  workspaceId,
} from '../previews/worker.fixture.js';

const actor = { workspaceId, actorId: actorUserId };
const signal = new AbortController().signal;
const everyRow = { filters: [], limit: 100, offset: 0 };
let tables: ReturnType<typeof createDataTablesStore>;
let worker: ReturnType<typeof createWorkerDataTablesStore>;

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

/** A dispatched attempt about to insert one row into a new table. */
async function dispatchedInsert() {
  const name = `Lost_${randomUUID().replaceAll('-', '')}`;
  const table = await tables.create({
    ...actor,
    idempotencyKey: randomUUID(),
    name,
    columns: [{ name: 'key', type: 'text', required: true }],
    keyColumn: 'key',
  });
  const claimed = await claimFixture(
    await acceptFixture({
      sideEffectClass: 'idempotent_with_key',
      providerIdempotencyKey: randomUUID(),
      mayContactProvider: false,
      mayCauseExternalSideEffect: true,
    }),
    `table-lost-${randomUUID()}`,
  );
  await markPreviewDispatched(workerPool, {
    lease: claimed.lease,
    workerId: claimed.workerId,
  });
  return {
    tableId: table.id,
    input: {
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
        table: name,
        values: { key: 'a' },
      },
    },
  };
}

it('tells the worker storage is unavailable when the database cannot be reached', async () => {
  const { input } = await dispatchedInsert();
  const nowhere = new URL(String(apiPool.options.connectionString));
  // Port 1 refuses every connection on a machine not serving tcpmux.
  nowhere.port = '1';
  const unreachable = createWorkerDataTablesStore(
    parseDatabaseConfig({
      connectionString: nowhere.toString(),
      max: 1,
      connectionTimeoutMillis: 2_000,
    }),
  );
  try {
    await expect(unreachable.execute(input)).rejects.toMatchObject({
      code: 'unavailable',
      message:
        'Data table storage is temporarily unavailable. The same write can be retried safely.',
    });
  } finally {
    await unreachable.close();
  }
});

it('tells the worker storage is unavailable when its connection dies mid-write, and the retry writes once', async () => {
  const { input, tableId } = await dispatchedInsert();
  const holder = await apiPool.connect();
  await holder.query('begin');
  await holder.query("select set_config('app.workspace_id',$1,true)", [
    workspaceId,
  ]);
  // Stops the write at its first lock, so the connection dies inside its transaction.
  await holder.query(
    'select 1 from app.workspace_data_table_quotas where workspace_id=$1 for update',
    [workspaceId],
  );
  const blockerPid = (
    await holder.query<{ pid: number }>('select pg_backend_pid() pid')
  ).rows[0]?.pid;
  try {
    const write = worker.execute(input);
    const settled = expect(write).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect
      .poll(
        () =>
          withAdmin(
            async (admin) =>
              (
                await admin.query<{ pid: number }>(
                  `select pid from pg_stat_activity
                   where $1=any(pg_blocking_pids(pid))`,
                  [blockerPid],
                )
              ).rows.length,
          ),
        { timeout: 10_000 },
      )
      .toBe(1);
    await withAdmin((admin) =>
      admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
         where $1=any(pg_blocking_pids(pid))`,
        [blockerPid],
      ),
    );
    await settled;
  } finally {
    await holder.query('rollback');
    holder.release();
  }

  const retried = await worker.execute(input);
  expect(retried.affected).toBe(1);
  const { rows } = await tables.find({ ...actor, tableId, query: everyRow });
  expect(rows.map(({ values }) => values)).toEqual([{ key: 'a' }]);
});
