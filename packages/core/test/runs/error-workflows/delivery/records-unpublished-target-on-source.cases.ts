import { readErrorWorkflow } from '../../../../src/runs/error-workflows/read.queries.js';

import { createWorkspacePurgeCoordinator } from '../../../../src/lifecycle/purge/repository.js';
import { maintenanceUrl } from '../../../lifecycle/retention.support.js';

import { withWorkspaceTransaction } from '@pertexo/database/primitives';

import { expect, it } from 'vitest';

import { parseDatabaseConfig } from '@pertexo/database/platform';

import { admin } from '../../../lifecycle/calls/fixtures.js';

import {
  pool,
  store,
  fixture,
  delivery,
  intent,
  publishManualTarget,
  fullQueue,
  cancelQueuedRun,
} from './fixture.js';

export function registerRecordsUnpublishedTargetOnSource(): void {
  it('records an unpublished target on the source run without creating a delivery', async () => {
    const f = await fixture();
    await admin.query(
      'update app.workflows set published_version_id=null where id=$1',
      [f.childWorkflowId],
    );
    await Promise.all([f.produce(), f.produce()]);
    expect(await intent(f)).toMatchObject({
      status: 'refused',
      refusal_code: 'target_not_published',
      accepted_run_id: null,
      outbox_event_id: null,
    });
    const visible = await withWorkspaceTransaction(
      pool,
      f.workspaceId,
      (transaction) => readErrorWorkflow(transaction, f.parentRunId),
    );
    expect(visible).toMatchObject({
      errorWorkflow: {
        status: 'refused',
        refusalCode: 'target_not_published',
        targetVersionId: null,
      },
    });
    const deliveries = await admin.query(
      "select id from app.outbox_events where workspace_id=$1 and aggregate_id=$2 and job_name='start-error-workflow'",
      [f.workspaceId, f.parentRunId],
    );
    expect(deliveries.rows).toHaveLength(0);
  });

  it('keeps one bounded pending intent under duplicate delivery, then admits once after capacity frees', async () => {
    const f = await fullQueue();
    const original = await delivery(f);
    await Promise.all([store.dispatch(original), store.dispatch(original)]);
    const pending = await intent(f);
    expect(pending).toMatchObject({
      status: 'pending',
      refusal_code: null,
      accepted_run_id: null,
    });
    expect(pending?.queue_wait_expires_at).toBeInstanceOf(Date);
    expect(pending?.outbox_event_id).not.toBe(original.outboxEventId);
    const next = await delivery(f);
    const scheduled = await admin.query<{ available_at: Date }>(
      'select available_at from app.outbox_events where id=$1',
      [next.outboxEventId],
    );
    expect(scheduled.rows[0]?.available_at).toEqual(
      pending?.queue_wait_expires_at,
    );
    await store.dispatch(next);
    expect((await intent(f))?.queue_wait_expires_at).toEqual(
      pending?.queue_wait_expires_at,
    );
    await cancelQueuedRun(f);
    const awake = await delivery(f);
    const due = await admin.query<{ due: boolean }>(
      'select available_at <= clock_timestamp() due from app.outbox_events where id=$1',
      [awake.outboxEventId],
    );
    expect(due.rows[0]?.due).toBe(true);
    const ready = await delivery(f);
    await Promise.all([
      store.dispatch(original),
      store.dispatch(ready),
      store.dispatch(next),
      store.dispatch(ready),
    ]);
    expect(await intent(f)).toMatchObject({
      status: 'accepted',
      refusal_code: null,
      queue_wait_expires_at: pending?.queue_wait_expires_at,
    });
    expect(
      (
        await admin.query(
          "select id from app.workflow_runs where workspace_id=$1 and trigger_type='workflow_error'",
          [f.workspaceId],
        )
      ).rows,
    ).toHaveLength(1);
  });

  it('refuses visibly after the fixed capacity-wait deadline without losing the source failure', async () => {
    const f = await fullQueue();
    await store.dispatch(await delivery(f));
    await admin.query(
      "update app.run_error_workflow_intents set queue_wait_expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and source_run_id=$2",
      [f.workspaceId, f.parentRunId],
    );
    await cancelQueuedRun(f);
    await store.dispatch(await delivery(f));
    expect(await intent(f)).toMatchObject({
      status: 'refused',
      refusal_code: 'queue_full',
      accepted_run_id: null,
    });
    expect(
      (
        await admin.query('select id from app.workflow_runs where id=$1', [
          f.parentRunId,
        ])
      ).rows,
    ).toHaveLength(1);
  });

  it('purges the policy and captured target intent through ordinary workspace deletion', async () => {
    const f = await fixture();
    await f.produce();
    await admin.query(
      "update app.workspaces set status='purging',deletion_requested_at=clock_timestamp()-interval '2 days',deletion_requested_by=created_by,deletion_reason='Owned qualification',purge_after=clock_timestamp()-interval '1 day' where id=$1",
      [f.workspaceId],
    );
    const purge = createWorkspacePurgeCoordinator(
      parseDatabaseConfig({ connectionString: maintenanceUrl, max: 1 }),
      {
        purgeWorkspacePage: () =>
          Promise.resolve({ completed: true, deletedCount: 0 }),
      },
      { pageSize: 2 },
    );
    try {
      let completed = false;
      for (let page = 0; page < 100 && !completed; page++) {
        const result = await purge.processNext();
        completed =
          result.status === 'completed' && result.workspaceId === f.workspaceId;
      }
      expect(completed).toBe(true);
      expect(
        (
          await admin.query(
            'select source_run_id from app.run_error_workflow_intents where workspace_id=$1',
            [f.workspaceId],
          )
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await admin.query(
            'select workflow_id from app.workflow_error_policies where workspace_id=$1',
            [f.workspaceId],
          )
        ).rows,
      ).toHaveLength(0);
    } finally {
      await purge.close();
    }
  });

  it('runs the version captured at failure even if a different publication becomes current', async () => {
    const f = await fixture();
    await f.produce();
    await publishManualTarget(f);
    await store.dispatch(await delivery(f));
    const result = await intent(f);
    const accepted = await admin.query<{ workflow_version_id: string }>(
      'select workflow_version_id from app.workflow_runs where id=$1',
      [result?.accepted_run_id],
    );
    expect(accepted.rows[0]?.workflow_version_id).toBe(f.childVersionId);
  });

  it('does not lose a release racing with replacement delivery', async () => {
    const f = await fullQueue();
    await store.dispatch(await delivery(f));
    const next = await delivery(f);
    await Promise.all([cancelQueuedRun(f), store.dispatch(next)]);
    if ((await intent(f))?.status === 'pending') {
      const ready = await delivery(f);
      const due = await admin.query<{ due: boolean }>(
        'select available_at <= clock_timestamp() due from app.outbox_events where id=$1',
        [ready.outboxEventId],
      );
      expect(due.rows[0]?.due).toBe(true);
      await store.dispatch(ready);
    }
    expect(await intent(f)).toMatchObject({ status: 'accepted' });
  });
}
