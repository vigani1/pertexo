import { expect, it } from 'vitest';
import { asAdmin, rawStore, workspaceA } from '../run-store.fixture.js';
import { emergencyRun, query } from './emergency.fixture.js';

it('settles an active run whose checkpoint is missing, with its specific safe reason and a terminal checkpoint', async () => {
  const f = await emergencyRun();
  await asAdmin((client) =>
    client.query('delete from app.run_checkpoints where workflow_run_id=$1', [
      f.runId,
    ]),
  );
  await expect(
    rawStore.loadAdvanceState({ workspaceId: workspaceA, runId: f.runId }),
  ).rejects.toMatchObject({
    name: 'CoordinatorRunStateCorruptError',
    revision: null,
  });
  expect(await f.fail()).toBe('failed');
  expect(
    (
      await query(
        'select status,error_summary,completed_at is not null as completed from app.workflow_runs where id=$1',
        [f.runId],
      )
    ).rows,
  ).toEqual([
    {
      status: 'failed',
      error_summary: 'execution.checkpoint_missing',
      completed: true,
    },
  ]);
  expect(
    (
      await query(
        'select revision,scheduler_state from app.run_checkpoints where workflow_run_id=$1',
        [f.runId],
      )
    ).rows,
  ).toEqual([
    {
      revision: 1,
      scheduler_state: expect.objectContaining({
        runStatus: 'failed',
        revision: 1,
      }) as unknown,
    },
  ]);
  expect(
    (
      await query(
        'select completed_at is not null as completed from app.inbox_receipts where message_id=$1',
        [f.delivery.outboxEventId],
      )
    ).rows,
  ).toEqual([{ completed: true }]);
  expect(
    (
      await query(
        'select active_runs from app.workspace_execution_admission_counters where workspace_id=$1',
        [workspaceA],
      )
    ).rows,
  ).toEqual([{ active_runs: 0 }]);
  const notice = await query<{ context: unknown }>(
    'select context from app.run_failure_notification_intents where workflow_run_id=$1',
    [f.runId],
  );
  expect(notice.rows[0]?.context).toMatchObject({
    terminalStatus: 'failed',
    primaryFailure: {
      source: 'run',
      safeErrorCode: 'execution.checkpoint_missing',
    },
  });
  expect(await f.fail()).toBe('not_active');
});
