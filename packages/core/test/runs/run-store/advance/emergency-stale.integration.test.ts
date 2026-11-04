import { expect, it } from 'vitest';
import { asAdmin, rawStore, workspaceA } from '../fixtures.js';
import { emergencyRun, query } from './emergency.fixture.js';

async function snapshot(runId: string) {
  return (
    await query(
      `select r.status,c.revision,c.scheduler_state,
    (select count(*)::int from app.run_events e where e.workflow_run_id=r.id) events,
    (select count(*)::int from app.run_failure_notification_intents i where i.workflow_run_id=r.id) notices,
    (select active_runs from app.workspace_execution_admission_counters where workspace_id=r.workspace_id) active
    from app.workflow_runs r join app.run_checkpoints c on c.workflow_run_id=r.id where r.id=$1`,
      [runId],
    )
  ).rows;
}
it('does not mutate an active run after the same delivery was completed by the real advance transaction', async () => {
  const f = await emergencyRun();
  await rawStore.acknowledgeAdvanceDelivery({
    workspaceId: workspaceA,
    runId: f.runId,
    delivery: f.delivery,
    signal: new AbortController().signal,
  });
  const before = await snapshot(f.runId);
  expect(await f.fail()).toBe('stale');
  expect(await snapshot(f.runId)).toEqual(before);
});
it('does not apply an old failure after a checkpoint repair advances its failed revision', async () => {
  const f = await emergencyRun();
  const before = await snapshot(f.runId);
  await asAdmin((client) =>
    client.query(
      'update app.run_checkpoints set scheduler_state=$2 where workflow_run_id=$1',
      [f.runId, { corrupt: true }],
    ),
  );
  await expect(
    rawStore.loadAdvanceState({ workspaceId: workspaceA, runId: f.runId }),
  ).rejects.toMatchObject({ name: 'CoordinatorRunStateCorruptError' });
  const checkpoint = before[0]?.scheduler_state;
  await asAdmin((client) =>
    client.query(
      'update app.run_checkpoints set revision=revision+1,scheduler_state=$2 where workflow_run_id=$1',
      [f.runId, checkpoint],
    ),
  );
  const repaired = await snapshot(f.runId);
  expect(await f.fail()).toBe('stale');
  expect(await snapshot(f.runId)).toEqual(repaired);
  expect(
    (
      await query(
        'select count(*)::int receipts from app.inbox_receipts where message_id=$1',
        [f.delivery.outboxEventId],
      )
    ).rows,
  ).toEqual([{ receipts: 0 }]);
});

it('verifies authoritative delivery identity before changing emergency state', async () => {
  const f = await emergencyRun();
  const before = await snapshot(f.runId);
  await expect(
    f.fail({ ...f.delivery, payloadChecksum: '0'.repeat(64) }),
  ).rejects.toMatchObject({ name: 'CoordinatorDeliveryMismatchError' });
  expect(await snapshot(f.runId)).toEqual(before);
  expect(
    (
      await query(
        'select count(*)::int receipts from app.inbox_receipts where message_id=$1',
        [f.delivery.outboxEventId],
      )
    ).rows,
  ).toEqual([{ receipts: 0 }]);
});
