import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  WorkflowPauseRevisionConflictError,
  WorkflowNotFoundError,
} from '../../../../src/testing.js';

import {
  fold,
  admin,
  worker,
  controls,
  seed,
  outcome,
  pause,
  failures,
  waitForBlocked,
} from './fixture.js';

export function registerSerializesBlockedEvaluatorResumeSkips(): void {
  it('serializes a blocked evaluator with resume and skips its pre-resume candidates', async () => {
    const scope = await seed();
    await pause(scope);
    for (let index = 0; index < 3; index++) await outcome(scope);
    const blocker = await admin.connect();
    try {
      await blocker.query('begin');
      const pid = (
        await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')
      ).rows[0]?.pid;
      if (pid === undefined) throw new Error('Missing backend pid');
      await blocker.query(
        "select pg_advisory_xact_lock(hashtextextended('auto-pause-workflow:'||$1::text||':'||$2::text,0))",
        [scope.workspaceId, scope.workflowId],
      );
      const pendingFold = fold.foldPending(1000);
      await waitForBlocked(pid);
      await blocker.query(
        "select set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
        [scope.workspaceId, scope.actorId],
      );
      // The same writes a resume makes, committed while the fold waits.
      await blocker.query(
        `insert into app.workflow_trigger_pause_periods
           (workspace_id, workflow_id, pause_revision, paused_at, resumed_at)
         select workspace_id, id, trigger_pause_revision, trigger_paused_at, clock_timestamp()
         from app.workflows where workspace_id = $1 and id = $2`,
        [scope.workspaceId, scope.workflowId],
      );
      await blocker.query(
        `update app.workflow_failure_streaks
         set consecutive_failures = 0, last_run_id = null, last_ended_at = null,
             resumed_after = clock_timestamp(), updated_at = clock_timestamp()
         where workspace_id = $1 and workflow_id = $2`,
        [scope.workspaceId, scope.workflowId],
      );
      await blocker.query(
        `update app.workflows
         set trigger_pause_state = 'none', trigger_paused_at = null,
             trigger_pause_reason = null, trigger_pause_failures = null,
             trigger_pause_last_run_id = null,
             trigger_pause_revision = trigger_pause_revision + 1
         where workspace_id = $1 and id = $2`,
        [scope.workspaceId, scope.workflowId],
      );
      await blocker.query('commit');
      expect(await pendingFold).toEqual([]);
      expect(await failures(scope)).toBe(0);
      expect((await controls().readWorkflowSettings(scope)).pauseState).toBe(
        'none',
      );
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
  });

  it('rejects malformed and stale resume revisions', async () => {
    const scope = await seed();
    await expect(
      controls().resumeWorkflow({
        ...scope,
        expectedPauseRevision: '0',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(WorkflowPauseRevisionConflictError);
    await expect(
      controls().resumeWorkflow({
        ...scope,
        expectedPauseRevision: '9223372036854775808',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(WorkflowPauseRevisionConflictError);
    await expect(
      controls().resumeWorkflow({
        ...scope,
        expectedPauseRevision: '2',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(WorkflowPauseRevisionConflictError);
  });

  it('excludes an old ending committed after resume without blocking its producer FK lock', async () => {
    const scope = await seed();
    await pause(scope);
    const runId = await outcome(scope);
    // A different outcome UUID cannot duplicate the same run; delete its
    // already-committed queue row, then reinsert in a terminal transaction.
    await admin.query(
      'delete from app.workflow_trigger_outcomes where workspace_id=$1 and run_id=$2',
      [scope.workspaceId, runId],
    );
    const producer = await worker.connect();
    try {
      await producer.query('begin');
      await producer.query("select set_config('app.workspace_id',$1,true)", [
        scope.workspaceId,
      ]);
      await producer.query(
        `insert into app.workflow_trigger_outcomes(id,workspace_id,workflow_id,run_id,counts_as_failure,ended_at)
        values($1,$2,$3,$4,true,clock_timestamp()-interval '1 minute')`,
        [randomUUID(), scope.workspaceId, scope.workflowId, runId],
      );
      const resumed = await controls().resumeWorkflow({
        ...scope,
        expectedPauseRevision: '2',
        idempotencyKey: randomUUID(),
      });
      expect(resumed.settings.pauseState).toBe('none');
      await producer.query('commit');
      await fold.foldPending(1000);
      expect(await failures(scope)).toBe(0);
    } finally {
      await producer.query('rollback');
      producer.release();
    }
  });

  it('rechecks opt-out and lifecycle after waiting for concurrent commands', async () => {
    for (const change of ['opt_out', 'archive'] as const) {
      const scope = await seed();
      await controls().updateWorkflowSettings({
        ...scope,
        enabled: true,
        thresholdOverride: 3,
        expectedSettingsRevision: 1,
        idempotencyKey: randomUUID(),
      });
      for (let index = 0; index < 3; index++) await outcome(scope);
      const blocker = await admin.connect();
      try {
        await blocker.query('begin');
        const pid = (
          await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')
        ).rows[0]?.pid;
        if (pid === undefined) throw new Error('Missing pid');
        await blocker.query(
          'select id from app.workflows where workspace_id=$1 and id=$2 for no key update',
          [scope.workspaceId, scope.workflowId],
        );
        const pending = fold.foldPending(1000);
        await waitForBlocked(pid);
        await blocker.query(
          change === 'opt_out'
            ? 'update app.workflows set auto_pause_enabled=false where workspace_id=$1 and id=$2'
            : "update app.workflows set lifecycle_status='archived' where workspace_id=$1 and id=$2",
          [scope.workspaceId, scope.workflowId],
        );
        await blocker.query('commit');
        expect(await pending).toEqual([]);
        expect((await controls().readWorkflowSettings(scope)).pauseState).toBe(
          'none',
        );
      } finally {
        await blocker.query('rollback');
        blocker.release();
      }
    }
  });

  it('takes the workspace lock before actor locks and rejects a concurrent workspace suspension', async () => {
    for (const suspend of [false, true]) {
      const scope = await seed();
      const blocker = await admin.connect();
      try {
        await blocker.query('begin');
        await blocker.query("set local statement_timeout='1s'");
        const pid = (
          await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')
        ).rows[0]?.pid;
        if (pid === undefined) throw new Error('Missing pid');
        await blocker.query(
          'select id from app.workspaces where id=$1 for update',
          [scope.workspaceId],
        );
        const pending = controls().updateWorkspaceSettings({
          ...scope,
          threshold: 4,
          expectedRevision: 1,
          idempotencyKey: randomUUID(),
        });
        // Attach a rejection consumer before releasing the suspension lock.
        const settled = pending.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await waitForBlocked(pid);
        await blocker.query('select id from app.users where id=$1 for update', [
          scope.actorId,
        ]);
        if (suspend)
          await blocker.query(
            "update app.workspaces set status='suspended' where id=$1",
            [scope.workspaceId],
          );
        await blocker.query('commit');
        const result = await settled;
        if (suspend)
          expect('error' in result && result.error).toBeInstanceOf(
            WorkflowNotFoundError,
          );
        else
          expect('value' in result && result.value.settings.threshold).toBe(4);
      } finally {
        await blocker.query('rollback');
        blocker.release();
      }
    }
  });
}
