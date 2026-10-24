import { eq } from 'drizzle-orm';
import { workflowRunValues } from '../../../src/schema.js';
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ExecutionCapabilityExpiredError } from '../../../src/attempts/dispatch/fence.js';
import { RunValuesLimitError } from '../../../src/runs/values/records.js';
import { copyRecoveryRunValues } from '../../../src/runs/values/queries.js';
import { readWorkflowRunListPage } from '../../../src/runs/queries/history/list.js';
import {
  withWorkspaceTransaction,
  withWorkspaceReadTransaction,
} from '../../../src/tenant-access/transactions.js';
import { RUN_VALUES_RETENTION_RULE } from '../../../src/runs/values/retention.js';
import {
  store,
  actorId,
  running,
  read,
  terminal,
  apiPool,
  dispatcherPool,
  workspaceId,
  workflowId,
  otherWorkspaceId,
  queryAsOwner,
  executionQuery,
  purgeTestWorkspace,
} from './fixtures.js';
it('repeats and replaces exact pairs, preserving empty and case-sensitive values', async () => {
  const scope = await running();
  await store.save({ ...scope, values: { orderId: ' A-1042 ', empty: '' } });
  await store.save({ ...scope, values: { orderId: 'A-1043' } });
  expect(await read(scope.runId)).toEqual({ orderId: 'A-1043', empty: '' });
});
it('serializes concurrent writes and refuses an eleventh key atomically', async () => {
  const scope = await running();
  await store.save({
    ...scope,
    values: Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`key${String(i)}`, 'initial']),
    ),
  });
  const results = await Promise.allSettled([
    store.save({ ...scope, values: { key9: 'first', key0: 'winner' } }),
    store.save({ ...scope, values: { key10: 'second', key0: 'loser' } }),
  ]);
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  const rejected = results.find((result) => result.status === 'rejected');
  expect(rejected?.reason).toBeInstanceOf(RunValuesLimitError);
  const values = await read(scope.runId);
  expect(Object.keys(values)).toHaveLength(10);
  expect(values.key0).toBe(values.key9 === 'first' ? 'winner' : 'loser');
});
it('refuses stale fences, foreign workspaces and canceled attempts without writing', async () => {
  const scope = await running();
  await expect(
    store.save({ ...scope, fenceToken: 2, values: { orderId: 'bad' } }),
  ).rejects.toBeInstanceOf(ExecutionCapabilityExpiredError);
  await expect(
    store.save({
      ...scope,
      workspaceId: otherWorkspaceId,
      values: { orderId: 'bad' },
    }),
  ).rejects.toBeInstanceOf(ExecutionCapabilityExpiredError);
  await executionQuery(
    `update app.workflow_runs set cancel_requested_at=clock_timestamp(),cancel_requested_by='values-test' where id=$1`,
    [scope.runId],
  );
  await expect(
    store.save({ ...scope, values: { orderId: 'bad' } }),
  ).rejects.toBeInstanceOf(ExecutionCapabilityExpiredError);
  expect(await read(scope.runId)).toEqual({});
});
it('filters by exact pair alongside status, workflow and time, without including tests or expired values', async () => {
  const ordinary = await running(),
    test = await running('test'),
    expired = await running();
  for (const scope of [ordinary, test, expired])
    await store.save({ ...scope, values: { orderId: 'A-1042', empty: '' } });
  await terminal(expired.runId, '31 days');
  const list = (key: string, value: string) =>
    readWorkflowRunListPage(apiPool, {
      actorId: actorId,
      workspaceId,
      limit: 20,
      workflowId,
      status: 'running',
      createdAtFrom: new Date(Date.now() - 3600000).toISOString(),
      runValueKey: key,
      runValue: value,
    });
  expect((await list('orderId', 'A-1042')).items.map((row) => row.id)).toEqual([
    ordinary.runId,
  ]);
  expect((await list('orderId', 'a-1042')).items).toEqual([]);
  expect((await list('empty', '')).items.map((row) => row.id)).toContain(
    ordinary.runId,
  );
  expect(await read(expired.runId)).toEqual({});
  const foreign = await withWorkspaceReadTransaction(
    apiPool,
    otherWorkspaceId,
    (transaction) =>
      transaction.db
        .select({ id: workflowRunValues.id })
        .from(workflowRunValues)
        .where(eq(workflowRunValues.workflowRunId, ordinary.runId)),
  );
  expect(foreign).toEqual([]);
});
it('copies bounded retained metadata for recovery atomically and allows later replacement', async () => {
  const source = await running(),
    target = await running();
  await store.save({ ...source, values: { orderId: 'source' } });
  await withWorkspaceTransaction(apiPool, workspaceId, (tx) =>
    copyRecoveryRunValues(tx, source.runId, target.runId),
  );
  expect(await read(target.runId)).toEqual({ orderId: 'source' });
  await store.save({ ...target, values: { orderId: 'new' } });
  expect(await read(source.runId)).toEqual({ orderId: 'source' });
  expect(await read(target.runId)).toEqual({ orderId: 'new' });
});
it('retains ordinary values for thirty days and tests for seven, then removes a bounded page', async () => {
  const retained = await running(),
    expired = await running(),
    test = await running('test');
  for (const scope of [retained, expired, test])
    await store.save({ ...scope, values: { orderId: scope.runId } });
  await terminal(retained.runId, '8 days');
  await terminal(expired.runId, '31 days');
  await terminal(test.runId, '8 days');
  expect(await read(retained.runId)).toEqual({ orderId: retained.runId });
  expect(await read(test.runId)).toEqual({});
  const cleaner = await dispatcherPool.connect();
  try {
    await RUN_VALUES_RETENTION_RULE.run(cleaner, 100);
  } finally {
    cleaner.release();
  }
  const rows = await queryAsOwner<{ workflow_run_id: string }>(
    'select workflow_run_id from app.workflow_run_values where workflow_run_id=any($1::uuid[])',
    [[retained.runId, expired.runId, test.runId]],
    workspaceId,
  );
  expect(rows.map((row) => row.workflow_run_id)).toEqual([retained.runId]);
});
it('purges recorded business values with their workspace', async () => {
  const scope = await running();
  await store.save({ ...scope, values: { orderId: randomUUID() } });
  await terminal(scope.runId, '1 minute');
  await purgeTestWorkspace(workspaceId);
  expect(await read(scope.runId)).toEqual({});
});
