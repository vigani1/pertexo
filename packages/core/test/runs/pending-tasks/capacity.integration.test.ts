import { expect, it } from 'vitest';
import { createFamily } from '../../lifecycle/calls/fixtures.js';
import { admin, store, sync, taskFixture } from './fixtures.js';

it('releases a quiescent slot and pauses the execution budget for a seven-day task', async () => {
  const f = await taskFixture();
  const paused = await sync(f);
  expect(paused.human_wait_started_at).toBeInstanceOf(Date);
  expect(paused.deadline_at).toBeNull();
  const clock = await admin.query<{ remaining_execution_ms: number }>(
    'select remaining_execution_ms from app.workflow_runs where id=$1',
    [f.parentRunId],
  );
  expect(clock.rows[0]?.remaining_execution_ms).toBeGreaterThan(1_790_000);
  const count = await admin.query(
    'select * from app.workflow_run_slot_counts($1)',
    [f.workspaceId],
  );
  expect(count.rows[0]).toMatchObject({ active_runs: 0 });
  await store.decide({
    ...f.scope,
    decision: 'approved',
    idempotencyKey: 'resume',
  });
  const resumed = await sync(f);
  expect(resumed.human_wait_started_at).toBeNull();
  expect(resumed.deadline_at?.getTime()).toBeGreaterThan(
    Date.now() + 1_790_000,
  );
});
it('preserves unlimited execution and a separately supplied absolute deadline', async () => {
  for (const input of [{ unlimited: true }, { hardDeadline: true }]) {
    const f = await taskFixture(input);
    const before = await admin.query<{ absolute_deadline_at: Date | null }>(
      'select absolute_deadline_at from app.workflow_runs where id=$1',
      [f.parentRunId],
    );
    expect((await sync(f)).deadline_at).toEqual(
      before.rows[0]?.absolute_deadline_at,
    );
    await store.decide({
      ...f.scope,
      decision: 'rejected',
      idempotencyKey: 'resume',
    });
    const after = await sync(f);
    expect(after.human_wait_started_at).toBeNull();
    if (input.unlimited) expect(after.deadline_at).toBeNull();
    else
      expect(after.deadline_at?.getTime()).toBeLessThan(Date.now() + 1_801_000);
  }
});
it('a decision does not steal a busy capacity-one slot; the ordinary wake retries later', async () => {
  const f = await taskFixture();
  await sync(f);
  await admin.query(
    'update app.workspace_execution_entitlement_versions set active_run_limit=1 where workspace_id=$1 and version=1',
    [f.workspaceId],
  );
  const competitor = await createFamily({
    workspaceId: f.workspaceId,
    childDays: 0,
    consumed: true,
  });
  await store.decide({
    ...f.scope,
    decision: 'approved',
    idempotencyKey: 'busy',
  });
  const deferred = await sync(f);
  expect(deferred.human_wait_started_at).toBeInstanceOf(Date);
  expect(deferred.human_resume_deferred).toBe(true);
  await admin.query(
    "update app.workflow_runs set status='succeeded',completed_at=clock_timestamp() where id=$1",
    [competitor.parentRunId],
  );
  expect((await sync(f)).human_wait_started_at).toBeNull();
});
it.each(['running', 'timed'] as const)(
  'a %s sibling retains the active slot and budget',
  async (sibling) => {
    const f = await taskFixture();
    await admin.query(
      `insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,status,side_effect_class,wait_kind,resume_at) values($1,$2,$3,'sibling',$4,'{}',$5,'safe',$6,$7)`,
      [
        crypto.randomUUID(),
        f.workspaceId,
        f.parentRunId,
        `${f.parentVersionId}|sibling|b:|i:`,
        sibling === 'running' ? 'running' : 'waiting',
        sibling === 'timed' ? 'node_wait' : null,
        sibling === 'timed' ? new Date(Date.now() + 60_000) : null,
      ],
    );
    const state = await sync(f);
    expect(state.human_wait_started_at).toBeNull();
    expect(state.deadline_at).toBeInstanceOf(Date);
  },
);
