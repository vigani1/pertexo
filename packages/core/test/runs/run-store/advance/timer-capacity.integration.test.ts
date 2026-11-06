import { expect, it } from 'vitest';
import { type WorkflowCheckpoint } from '@pertexo/workflow-engine';
import { createCheckpoint } from '@pertexo/workflow-engine/server';
import {
  releaseSlotDuringTimedWait,
  reacquireSlotAfterTimedWait,
} from '../../../../src/runs/advance/timed-wait-slot.repository.js';
import {
  asAdmin,
  asRuntime,
  insertRun,
  randomUUID,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../run-store.fixture.js';

it('refreshes stored capacity when the real timer helpers park and resume without a status change', async () => {
  const invocationKey = `${versionA}|timer|b:|i:`;
  const state: WorkflowCheckpoint = {
    ...createCheckpoint({ workflowVersionId: versionA, iterationBudget: 200 }),
    runStatus: 'waiting',
    invocations: [
      {
        invocationKey,
        nodeId: 'timer',
        status: 'waiting',
        waitKind: 'node_wait',
        attemptNumber: 0,
        resumeAt: '2099-01-01T00:00:00.000Z',
      },
    ],
  };
  const runId = await insertRun({ status: 'waiting', schedulerState: state });
  const scope = { workspaceId: workspaceA, runId };
  await asAdmin((client) =>
    client.query(
      `insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,status,side_effect_class,wait_kind,resume_at)
    values($1,$2,$3,'timer',$4,'{}','waiting','safe','node_wait','2099-01-01')`,
      [randomUUID(), workspaceA, runId, invocationKey],
    ),
  );
  const counts = () =>
    asRuntime(
      workerBaseUrl,
      workspaceA,
      async (client) =>
        (
          await client.query<{
            stored: number;
            actual: number;
            parked: boolean;
            status: string;
          }>(
            `select counter.active_runs stored,slots.active_runs actual,run.timed_wait_started_at is not null parked,run.status
    from app.workspace_execution_admission_counters counter cross join lateral app.workflow_run_slot_counts(counter.workspace_id) slots
    join app.workflow_runs run on run.workspace_id=counter.workspace_id where counter.workspace_id=$1 and run.id=$2`,
            [workspaceA, runId],
          )
        ).rows,
    );
  try {
    expect(await counts()).toEqual([
      { stored: 1, actual: 1, parked: false, status: 'waiting' },
    ]);
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query('select app.lock_workspace_run_admission($1)', [
        workspaceA,
      ]);
      await client.query(
        'select id from app.workflow_runs where id=$1 for update',
        [runId],
      );
      await releaseSlotDuringTimedWait(client, scope, {
        checkpoint: state,
        row: { timed_wait_started_at: null },
      });
    });
    expect(await counts()).toEqual([
      { stored: 0, actual: 0, parked: true, status: 'waiting' },
    ]);
    await asAdmin((client) =>
      client.query(
        "update app.node_runs set resume_at=clock_timestamp()-interval '1 second' where workflow_run_id=$1",
        [runId],
      ),
    );
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query('select app.lock_workspace_run_admission($1)', [
        workspaceA,
      ]);
      const row = (
        await client.query<{
          timed_wait_started_at: Date | null;
          execution_entitlement_version: number;
        }>(
          'select timed_wait_started_at,execution_entitlement_version from app.workflow_runs where id=$1 for update',
          [runId],
        )
      ).rows[0];
      if (row === undefined) throw new Error('Timer run missing');
      expect(
        await reacquireSlotAfterTimedWait(client, scope, row),
      ).toMatchObject({ timed_wait_started_at: null });
    });
    expect(await counts()).toEqual([
      { stored: 1, actual: 1, parked: false, status: 'waiting' },
    ]);
  } finally {
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        "update app.workflow_runs set status='succeeded',completed_at=clock_timestamp(),timed_wait_started_at=null where id=$1",
        [runId],
      ),
    );
  }
});
