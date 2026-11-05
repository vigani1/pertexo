import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  beforeAllFixture1,
  afterAllFixture2,
  owner,
  workerPool,
  workerQuery,
  ownerQuery,
  actorId,
  workspaceId,
  publishTriggerWorkflow,
  deliverReconciliation,
  reconciliation,
} from './webhooks/webhooks.fixture.js';
import { waitForBlockedBy } from '../support/postgres/lock-coordination.js';

beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);
async function restoreWorkspace() {
  await ownerQuery(
    "update app.workspaces set status='active',deletion_requested_at=null,deletion_requested_by=null,deletion_reason=null,purge_after=null where id=$1",
    [workspaceId],
  );
}
async function state(workflowId: string) {
  return (
    await workerQuery<{
      status: string;
      health_status: string;
      schedules: number;
    }>(
      `select trigger.status,trigger.health_status,
    (select count(*)::int from app.trigger_schedules schedule where schedule.trigger_id=trigger.id) schedules
    from app.workflow_triggers trigger where trigger.workflow_id=$1 order by trigger.id`,
      [workflowId],
    )
  ).rows;
}
it('does not materialize or change queued trigger configuration while suspended, and retries normally after reactivation', async () => {
  const f = await publishTriggerWorkflow();
  const workflowId = f.created.workflowId;
  const event = { eventId: f.eventId, payloadChecksum: f.eventChecksum };
  const before = await state(workflowId);
  await ownerQuery("update app.workspaces set status='suspended' where id=$1", [
    workspaceId,
  ]);
  try {
    await expect(
      deliverReconciliation(workflowId, f.published.version.id, event),
    ).rejects.toMatchObject({ code: '55000' });
    await reconciliation.recordFailure({
      workspaceId,
      workflowId,
      publishedVersionId: f.published.version.id,
      error: new Error('queued reconciliation refused'),
    });
    expect(await state(workflowId)).toEqual(before);
  } finally {
    await restoreWorkspace();
  }
  expect(
    await deliverReconciliation(workflowId, f.published.version.id, event),
  ).toHaveLength(2);
  expect((await state(workflowId)).some((row) => row.schedules === 1)).toBe(
    true,
  );
  await ownerQuery("update app.workspaces set status='suspended' where id=$1", [
    workspaceId,
  ]);
  try {
    expect(
      await deliverReconciliation(workflowId, f.published.version.id, event),
    ).toEqual([]);
  } finally {
    await restoreWorkspace();
  }
});
it.each([false, true])(
  'lets deletion finish and refuses queued enablement after commit, with delivery receipt %s',
  async (withReceipt) => {
    const f = await publishTriggerWorkflow();
    const workflowId = f.created.workflowId;
    const before = await state(workflowId);
    const deletion = await owner.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await deletion.query('begin');
      await deletion.query('set local role pertexo_owner');
      const pid = (
        await deletion.query<{ pid: number }>('select pg_backend_pid() pid')
      ).rows[0]?.pid;
      if (pid === undefined) throw new Error('Missing deletion session');
      await deletion.query(
        'select id from app.workspaces where id=$1 for update',
        [workspaceId],
      );
      await deletion.query(
        "update app.workspaces set status='pending_deletion',deletion_requested_at=clock_timestamp(),deletion_requested_by=$2,deletion_reason='integration fence',purge_after=clock_timestamp()+interval '1 day' where id=$1",
        [workspaceId, actorId],
      );
      const outcome = reconciliation
        .reconcile({
          workspaceId,
          workflowId,
          publishedVersionId: f.published.version.id,
          outboxEventId: f.eventId,
          ...(withReceipt
            ? {
                delivery: {
                  outboxEventId: f.eventId,
                  payloadChecksum: f.eventChecksum,
                },
              }
            : {}),
        })
        .then(
          (value) => ({ accepted: true, value }),
          (error: unknown) => ({ accepted: false, error }),
        );
      pending = outcome;
      await waitForBlockedBy(workerPool, pid, { timeout: 5_000 });
      // Deletion owns workspace first and must still be able to stop its workflows.
      await deletion.query(
        "update app.workflows set activation_status='inactive' where id=$1",
        [workflowId],
      );
      await deletion.query('commit');
      expect(await outcome).toMatchObject({
        accepted: false,
        error: { code: '55000' },
      });
      expect(await state(workflowId)).toEqual(before);
    } finally {
      await deletion.query('rollback');
      deletion.release();
      await pending;
      await restoreWorkspace();
    }
  },
);
