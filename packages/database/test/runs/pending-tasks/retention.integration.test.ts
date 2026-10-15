import { expect, it } from 'vitest';
import { admin, store, taskFixture, sync } from './fixtures.js';
import { retention } from '../../lifecycle/retention.support.js';
it('retains expired input during human waiting and cascades decided task history with run details', async () => {
  const f = await taskFixture();
  await sync(f);
  for (let pass = 0; pass < 20; pass++)
    if (!(await retention.enforce()).more) break;
  expect(
    (
      await admin.query<{ input_ref: unknown }>(
        'select input_ref from app.workflow_runs where id=$1',
        [f.parentRunId],
      )
    ).rows[0]?.input_ref,
  ).toBeTruthy();
  await store.decide({
    ...f.scope,
    decision: 'approved',
    comment: 'Retained with the run',
    idempotencyKey: 'retention',
  });
  await admin.query(
    "update app.node_runs set status='succeeded',control_kind=null,resume_at=null,completed_at=clock_timestamp()-interval '31 days' where id=$1",
    [f.nodeRunId],
  );
  await admin.query(
    "update app.workflow_runs set status='succeeded',completed_at=clock_timestamp()-interval '31 days' where id=$1",
    [f.parentRunId],
  );
  for (let pass = 0; pass < 50; pass++)
    if (!(await retention.enforce()).more) break;
  expect(
    (
      await admin.query('select id from app.pending_run_tasks where id=$1', [
        f.taskId,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await admin.query('select id from app.workflow_runs where id=$1', [
        f.parentRunId,
      ])
    ).rows,
  ).toHaveLength(1);
});
