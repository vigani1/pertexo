import {
  createCheckpoint,
  settleCallableResult,
} from '@pertexo/workflow-engine/server';
import { afterAll, expect, it } from 'vitest';
import { createWorkflowRunDatabase } from '../../../../src/runs/workflow-run.store.js';
import {
  actorId,
  apiBaseUrl,
  asOwner,
  databaseUrl,
  parseDatabaseConfig,
  workspaceA,
  versionA,
  insertRun,
  ownedDeliveryStore,
} from '../run-store.fixture.js';
import { emergencyRun } from './emergency.fixture.js';

const reads = createWorkflowRunDatabase(
  parseDatabaseConfig({ connectionString: databaseUrl(apiBaseUrl), max: 2 }),
);
afterAll(() => reads.close());

it('returns the run-level emergency cause through Get and List without inventing a failed step', async () => {
  const run = await emergencyRun();
  expect(await run.fail()).toBe('failed');
  const scope = { workspaceId: workspaceA, actorId };
  expect(await reads.get({ ...scope, runId: run.runId })).toMatchObject({
    run: { status: 'failed', failureReasonCode: 'execution.run_state_invalid' },
    nodes: [],
  });
  expect(
    (await reads.list({ ...scope, limit: 50 })).items.find(
      (row) => row.id === run.runId,
    ),
  ).toMatchObject({
    failureReasonCode: 'execution.run_state_invalid',
    failedStep: null,
  });
  await asOwner(workspaceA, (client) =>
    client.query('update app.workflow_runs set error_summary=$1 where id=$2', [
      'private provider text password=secret',
      run.runId,
    ]),
  );
  const damaged = await reads.get({ ...scope, runId: run.runId });
  expect(damaged?.run).toMatchObject({ failureReasonCode: null });
  expect(JSON.stringify(damaged)).not.toContain('private provider text');
});

it('keeps a callable-result failure after otherwise successful execution readable without a failed step', async () => {
  const runId = await insertRun({ status: 'running' });
  const initial = createCheckpoint({
    workflowVersionId: versionA,
    iterationBudget: 200,
    nextEventSequence: 2,
  });
  const plan = settleCallableResult(
    {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: {
        ...initial,
        revision: 1,
        runStatus: 'succeeded',
        nextEventSequence: 3,
      },
      events: [
        {
          name: 'run.succeeded',
          sequence: 2,
          occurredAt: new Date().toISOString(),
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    },
    { kind: 'invalid', reasonCode: 'callable_result_invalid' },
  );
  expect(
    await ownedDeliveryStore.commitAdvancePlan({
      workspaceId: workspaceA,
      runId,
      signal: new AbortController().signal,
      plan,
    }),
  ).toMatchObject({ kind: 'committed' });
  const scope = { workspaceId: workspaceA, actorId };
  expect(await reads.get({ ...scope, runId })).toMatchObject({
    run: { status: 'failed', failureReasonCode: 'callable_result_invalid' },
    nodes: [],
  });
  expect(
    (await reads.list({ ...scope, limit: 50 })).items.find(
      (row) => row.id === runId,
    ),
  ).toMatchObject({
    failureReasonCode: 'callable_result_invalid',
    failedStep: null,
  });
});
