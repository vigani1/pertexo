import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  beforeAllFixture1,
  afterAllFixture2,
  identity,
  authoring,
  fold,
  admin,
  controls,
  seed,
  outcome,
  pause,
  failures,
  auditCount,
  pausePeriodCount,
  worker,
  waitForBlocked,
  maintenanceUrl,
} from './auto-pause-controls/fixture.js';
import { randomUUID } from 'node:crypto';
import {
  WorkflowAutoPauseSettingsRevisionConflictError,
  WorkspaceAutoPauseSettingsRevisionConflictError,
  WorkflowNotFoundError,
  WorkflowPauseRevisionConflictError,
} from '../../../src/testing.js';
import { IdempotencyConflictError } from '@pertexo/database/platform';
import { enforceRetention } from '../../support/retention.js';

beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);
describe('workflow auto pause operational controls', () => {
  it('reads defaults, changes independently versioned settings and makes exact retries/no-ops durable', async () => {
    const scope = await seed();
    const initial = await controls().readWorkflowSettings(scope);
    expect(initial).toMatchObject({
      enabled: true,
      thresholdOverride: null,
      workspaceThreshold: 10,
      effectiveThreshold: 10,
      settingsRevision: 1,
      pauseState: 'none',
      pauseRevision: '1',
      pausedAt: null,
    });
    const command = {
      ...scope,
      enabled: false,
      thresholdOverride: 5,
      expectedSettingsRevision: 1,
      idempotencyKey: randomUUID(),
    };
    const accepted = await controls().updateWorkflowSettings(command);
    expect(accepted.settings).toMatchObject({
      enabled: false,
      effectiveThreshold: 5,
      settingsRevision: 2,
    });
    expect(await controls().updateWorkflowSettings(command)).toEqual({
      ...accepted,
      replayed: true,
    });
    await expect(
      controls().updateWorkflowSettings({ ...command, enabled: true }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      controls().updateWorkflowSettings({
        ...command,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(WorkflowAutoPauseSettingsRevisionConflictError);
    const noop = await controls().updateWorkflowSettings({
      ...command,
      expectedSettingsRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect(noop.settings.settingsRevision).toBe(2);
    expect(
      await auditCount(scope, 'workflow.auto_pause_settings_changed'),
    ).toBe(1);
    expect(
      (
        await authoring.getWorkflow(
          scope.workspaceId,
          scope.workflowId,
          scope.actorId,
        )
      )?.lifecycleRevision,
    ).toBe(1);
  });

  it('keeps maximum-threshold evidence while disabled and uses it when enabled again', async () => {
    const scope = await seed();
    await controls().updateWorkflowSettings({
      ...scope,
      enabled: false,
      thresholdOverride: 100,
      expectedSettingsRevision: 1,
      idempotencyKey: randomUUID(),
    });
    for (let i = 0; i < 150; i++)
      await outcome(
        scope,
        new Date(Date.now() + 1000 + i * 1000).toISOString(),
      );
    expect(await fold.foldPending(1000)).toEqual([]);
    expect(await failures(scope)).toBe(100);
    expect(
      (
        await admin.query(
          'select count(*)::int count from app.workflow_trigger_failures where workflow_id=$1',
          [scope.workflowId],
        )
      ).rows,
    ).toEqual([{ count: 100 }]);
    await controls().updateWorkflowSettings({
      ...scope,
      enabled: true,
      thresholdOverride: 100,
      expectedSettingsRevision: 2,
      idempotencyKey: randomUUID(),
    });
    // Settings do not pause retroactively, but the next evaluation uses the existing streak.
    expect((await controls().readWorkflowSettings(scope)).pauseState).toBe(
      'none',
    );
    await outcome(scope, new Date(Date.now() + 200_000).toISOString());
    expect(await fold.foldPending(1000)).toEqual([
      {
        workspaceId: scope.workspaceId,
        workflowId: scope.workflowId,
        consecutiveFailures: 100,
      },
    ]);
    expect(await failures(scope)).toBe(100);
    expect(await auditCount(scope, 'workflow.triggers_paused')).toBe(1);
    expect(
      await auditCount(scope, 'workflow.auto_pause_settings_changed'),
    ).toBe(2);
  });

  it('resumes atomically, discards old pending outcomes, counts new endings and replays the accepted snapshot', async () => {
    const scope = await seed();
    await pause(scope);
    for (let index = 0; index < 3; index++) await outcome(scope);
    const command = {
      ...scope,
      expectedPauseRevision: '2',
      idempotencyKey: randomUUID(),
    };
    const accepted = await controls().resumeWorkflow(command);
    expect(accepted.settings).toMatchObject({
      pauseState: 'none',
      pauseRevision: '3',
      pausedAt: null,
      pausedFailures: null,
      pausedLastRunId: null,
    });
    expect(await failures(scope)).toBe(0);
    expect(await auditCount(scope, 'workflow.triggers_resumed')).toBe(1);
    await fold.foldPending(1000);
    expect(await failures(scope)).toBe(0);
    for (let index = 0; index < 3; index++)
      await outcome(scope, new Date(Date.now() + 1000 + index).toISOString());
    await fold.foldPending(1000);
    expect((await controls().readWorkflowSettings(scope)).pauseRevision).toBe(
      '4',
    );
    expect(await controls().resumeWorkflow(command)).toEqual({
      ...accepted,
      replayed: true,
    });
    expect(await pausePeriodCount(scope)).toBe(1);
    await expect(
      controls().resumeWorkflow({ ...command, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ currentRevision: '4' });
    expect(await auditCount(scope, 'workflow.triggers_resumed')).toBe(1);
  });

  it('keeps a non-paused resume a no-op even with a live streak, and preserves bigint revisions', async () => {
    const scope = await seed();
    await outcome(scope);
    await fold.foldPending(1000);
    await controls().resumeWorkflow({
      ...scope,
      expectedPauseRevision: '1',
      idempotencyKey: randomUUID(),
    });
    expect(await failures(scope)).toBe(1);
    expect(await auditCount(scope, 'workflow.triggers_resumed')).toBe(0);
    expect(await pausePeriodCount(scope)).toBe(0);
    await admin.query(
      `update app.workflows set trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),
      trigger_pause_reason='consecutive_failures',trigger_pause_failures=3,trigger_pause_last_run_id=gen_random_uuid(),
      trigger_pause_revision=9007199254740993,lifecycle_status='archived'
      where workspace_id=$1 and id=$2`,
      [scope.workspaceId, scope.workflowId],
    );
    expect((await controls().readWorkflowSettings(scope)).pauseRevision).toBe(
      '9007199254740993',
    );
    const result = await controls().resumeWorkflow({
      ...scope,
      expectedPauseRevision: '9007199254740993',
      idempotencyKey: randomUUID(),
    });
    expect(result.settings.pauseRevision).toBe('9007199254740994');
    expect(
      (
        await authoring.getWorkflow(
          scope.workspaceId,
          scope.workflowId,
          scope.actorId,
        )
      )?.lifecycleStatus,
    ).toBe('archived');
  });

  it('uses workspace:manage owner-only while readers and workflow editors have their own scopes', async () => {
    const scope = await seed();
    for (const role of ['admin', 'builder', 'operator', 'viewer'] as const) {
      const actorId = (
        await identity.createUser({
          email: `${randomUUID()}@example.test`,
          displayName: role,
        })
      ).id;
      await admin.query(
        "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,'active')",
        [scope.workspaceId, actorId, role],
      );
      const actor = { ...scope, actorId };
      await expect(
        controls().readWorkflowSettings(actor),
      ).resolves.toBeDefined();
      await expect(
        controls().updateWorkspaceSettings({
          ...actor,
          threshold: 4,
          expectedRevision: 1,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
      const settings = {
        ...actor,
        enabled: false,
        thresholdOverride: null,
        expectedSettingsRevision: role === 'builder' ? 2 : 1,
        idempotencyKey: randomUUID(),
      };
      if (role === 'admin' || role === 'builder')
        await expect(
          controls().updateWorkflowSettings(settings),
        ).resolves.toBeDefined();
      else
        await expect(
          controls().updateWorkflowSettings(settings),
        ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    }
    const accepted = await controls().updateWorkspaceSettings({
      ...scope,
      threshold: 4,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(accepted.settings).toEqual({ threshold: 4, revision: 2 });
    await expect(
      controls().updateWorkspaceSettings({
        ...scope,
        threshold: 8,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(WorkspaceAutoPauseSettingsRevisionConflictError);
    expect(
      (await controls().readWorkflowSettings(scope)).workspaceThreshold,
    ).toBe(4);
  });

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

  it('rolls back pause, streak, audit and receipt together when the audit insert fails', async () => {
    const scope = await seed();
    await pause(scope);
    const command = {
      ...scope,
      expectedPauseRevision: '2',
      idempotencyKey: randomUUID(),
    };
    await admin.query(`alter table app.audit_events add constraint test_pause_audit_failure check
      (workspace_id<> '${scope.workspaceId}'::uuid or action<> 'workflow.triggers_resumed')`);
    try {
      await expect(controls().resumeWorkflow(command)).rejects.toThrow(
        /test_pause_audit_failure/u,
      );
      expect((await controls().readWorkflowSettings(scope)).pauseState).toBe(
        'paused',
      );
      expect(await failures(scope)).toBe(3);
      expect(await auditCount(scope, 'workflow.triggers_resumed')).toBe(0);
      expect(await pausePeriodCount(scope)).toBe(0);
    } finally {
      await admin.query(
        'alter table app.audit_events drop constraint test_pause_audit_failure',
      );
    }
    const accepted = await controls().resumeWorkflow(command);
    expect(accepted.replayed).toBe(false);
    expect(accepted.settings.pauseState).toBe('none');
    expect(await failures(scope)).toBe(0);
    expect(await pausePeriodCount(scope)).toBe(1);
  });

  it('removes completed expired control receipts through retention', async () => {
    const scope = await seed();
    const command = {
      ...scope,
      enabled: false,
      thresholdOverride: null,
      expectedSettingsRevision: 1,
      idempotencyKey: randomUUID(),
    };
    await controls().updateWorkflowSettings(command);
    await admin.query(
      "update app.idempotency_records set created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and operation='workflow.autopause.settings'",
      [scope.workspaceId],
    );
    const removed = await enforceRetention(maintenanceUrl);
    expect(removed.idempotency_records).toBeGreaterThanOrEqual(1);
    expect(
      (
        await admin.query(
          "select 1 from app.idempotency_records where workspace_id=$1 and operation='workflow.autopause.settings'",
          [scope.workspaceId],
        )
      ).rows,
    ).toHaveLength(0);
    // An expired, reaped key is a new command, and must satisfy current CAS.
    await expect(
      controls().updateWorkflowSettings(command),
    ).rejects.toBeInstanceOf(WorkflowAutoPauseSettingsRevisionConflictError);
  });
});
