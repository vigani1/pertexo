import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRunValuesStore } from '../../../src/runs/values/repository.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { completePreviewAttempt } from '../../../src/previews/attempts/complete.js';
import { createPreviewRetentionCoordinator } from '../../../src/lifecycle/previews/repository.js';
import {
  acceptFixture,
  claimFixture,
  apiPool,
  workerPool,
  workspaceId,
  apiScopedQuery,
  withAdmin,
  databaseUrl,
  maintenanceBaseUrl,
} from '../../previews/worker.fixture.js';
let store: ReturnType<typeof createRunValuesStore>;
beforeAll(() => {
  const connectionString = apiPool.options.connectionString;
  if (connectionString === undefined) throw new Error('Owned database missing');
  store = createRunValuesStore(
    parseDatabaseConfig({ connectionString, max: 4 }),
  );
});
afterAll(() => store.close());
it('records preview business values without provider dispatch and cascades them at preview expiry', async () => {
  const claimed = await claimFixture(
    await acceptFixture({
      sideEffectClass: 'safe',
      mayContactProvider: false,
      mayCauseExternalSideEffect: false,
    }),
    `values-${randomUUID()}`,
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
    signal: new AbortController().signal,
    values: { orderId: 'preview-order' },
  };
  expect(await store.save(input)).toEqual(input.values);
  await expect(
    store.save({ ...input, fenceToken: input.fenceToken + 1 }),
  ).rejects.toHaveProperty('name', 'ExecutionCapabilityExpiredError');
  await expect(
    store.save({ ...input, runId: randomUUID() }),
  ).rejects.toHaveProperty('name', 'ExecutionCapabilityExpiredError');
  expect(
    (
      await apiScopedQuery(
        'select workflow_run_id,preview_run_id,key,value from app.workflow_run_values where preview_run_id=$1',
        [input.runId],
      )
    ).rows,
  ).toEqual([
    {
      workflow_run_id: null,
      preview_run_id: input.runId,
      key: 'orderId',
      value: 'preview-order',
    },
  ]);
  await completePreviewAttempt(workerPool, {
    delivery: claimed.fixture.delivery,
    lease: claimed.lease,
    workerId: claimed.workerId,
    outcome: {
      status: 'succeeded',
      output: { kind: 'inline', value: { values: input.values } },
    },
  });
  await withAdmin((admin) =>
    admin.query(
      "update app.preview_runs set created_at=clock_timestamp()-interval '8 days',started_at=clock_timestamp()-interval '8 days'+interval '1 second',completed_at=clock_timestamp()-interval '8 days'+interval '2 seconds',execution_deadline_at=clock_timestamp()-interval '7 days',expires_at=clock_timestamp()-interval '6 days' where id=$1",
      [input.runId],
    ),
  );
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
      previewRunId: input.runId,
    });
  } finally {
    await retention.close();
  }
  expect(
    (
      await apiScopedQuery(
        'select id from app.workflow_run_values where preview_run_id=$1',
        [input.runId],
      )
    ).rows,
  ).toEqual([]);
});
