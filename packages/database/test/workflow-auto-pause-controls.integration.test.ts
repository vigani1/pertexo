import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../src/migrations.js';
import {
  createIdentityWorkspaceDatabase,
  createWorkflowAuthoringDatabase,
  parseDatabaseConfig,
  WorkflowPauseRevisionConflictError,
  WorkflowAutoPauseSettingsRevisionConflictError,
  WorkspaceAutoPauseSettingsRevisionConflictError,
  WorkflowIdempotencyConflictError,
  WorkflowNotFoundError,
} from '../src/testing.js';
import { createWorkflowTriggerPauseFoldStore } from '../src/triggers/pause/fold-store.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';
import { enforceRetention } from './support/retention.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
  databaseName: `pertexo_test_pause_controls_${randomUUID().replaceAll('-', '')}`,
  ownerRole: 'pertexo_owner',
});
const url = (variable: string, fallback: string) =>
  fixture.databaseUrl(process.env[variable] ?? fallback);
const migrationUrl = url(
  'DATABASE_MIGRATION_URL',
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo',
);
const apiUrl = url(
  'DATABASE_URL',
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo',
);
const workerUrl = url(
  'DATABASE_URL',
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo',
);
const maintenanceUrl = url(
  'DATABASE_MAINTENANCE_URL',
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
);
let identity: ReturnType<typeof createIdentityWorkspaceDatabase>;
let authoring: ReturnType<typeof createWorkflowAuthoringDatabase>;
let fold: ReturnType<typeof createWorkflowTriggerPauseFoldStore>;
let admin: Pool;
let api: Pool;
let worker: Pool;
beforeAll(async () => {
  await fixture.create();
  await migrateDatabase({
    connectionString: migrationUrl,
    ownerRole: 'pertexo_owner',
    appRole: 'pertexo_app',
    maintenanceRole: 'pertexo_maintenance',
  });
  identity = createIdentityWorkspaceDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  );
  authoring = createWorkflowAuthoringDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 6 }),
  );
  fold = createWorkflowTriggerPauseFoldStore(
    parseDatabaseConfig({ connectionString: workerUrl, max: 6 }),
  );
  admin = new Pool({ connectionString: fixture.databaseUrl(adminUrl), max: 4 });
  api = new Pool({ connectionString: apiUrl, max: 2 });
  worker = new Pool({ connectionString: workerUrl, max: 2 });
}, 60_000);
function closeStore(store: { close(): Promise<void> } | undefined) {
  return store?.close();
}
function closePool(pool: Pool | undefined) {
  return pool?.end();
}
afterAll(async () => {
  const results = await Promise.allSettled([
    closeStore(identity),
    closeStore(authoring),
    closeStore(fold),
    closePool(admin),
    closePool(api),
    closePool(worker),
  ]);
  await fixture.drop();
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
});
const controls = () => {
  const result = authoring.autoPause;
  if (result === undefined) throw new Error('Missing controls');
  return result;
};
async function seed() {
  const actorId = (
    await identity.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Owner',
    })
  ).id;
  const workspaceId = (
    await identity.createWorkspaceWithOwner({
      name: 'Pause controls',
      slug: `pause-${randomUUID().slice(0, 8)}`,
      ownerUserId: actorId,
    })
  ).id;
  const workflowId = randomUUID();
  await admin.query(
    'insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,$3,$4)',
    [workflowId, workspaceId, 'Import', actorId],
  );
  return { workspaceId, workflowId, actorId };
}
type Scope = Awaited<ReturnType<typeof seed>>;
async function outcome(
  scope: Scope,
  endedAt = new Date(Date.now() - 60_000).toISOString(),
  failure = true,
) {
  const runId = randomUUID();
  await admin.query(
    `with tenant as (select set_config('app.workspace_id',$2::uuid::text,true))
    insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
    select $1::uuid,$2::uuid,$3::uuid,$4::uuid,'schedule',$5 from tenant`,
    [
      runId,
      scope.workspaceId,
      scope.workflowId,
      randomUUID(),
      failure ? 'failed' : 'succeeded',
    ],
  );
  const client = await worker.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      scope.workspaceId,
    ]);
    await client.query(
      `insert into app.workflow_trigger_outcomes(id,workspace_id,workflow_id,run_id,counts_as_failure,ended_at)
      values($1,$2,$3,$4,$5,$6)`,
      [
        randomUUID(),
        scope.workspaceId,
        scope.workflowId,
        runId,
        failure,
        endedAt,
      ],
    );
    await client.query('commit');
  } finally {
    client.release();
  }
  return runId;
}
async function pause(scope: Scope) {
  await controls().updateWorkflowSettings({
    ...scope,
    enabled: true,
    thresholdOverride: 3,
    expectedSettingsRevision: 1,
    idempotencyKey: randomUUID(),
  });
  for (let index = 0; index < 3; index++) await outcome(scope);
  await fold.foldPending(1000, true);
  expect((await controls().readWorkflowSettings(scope)).pauseState).toBe(
    'paused',
  );
}
async function failures(scope: Scope) {
  const result = await admin.query<{ consecutive_failures: number }>(
    'select consecutive_failures from app.workflow_failure_streaks where workspace_id=$1 and workflow_id=$2',
    [scope.workspaceId, scope.workflowId],
  );
  return result.rows[0]?.consecutive_failures;
}
async function auditCount(scope: Scope, action: string) {
  const result = await admin.query<{ count: number }>(
    'select count(*)::int as count from app.audit_events where workspace_id=$1 and action=$2',
    [scope.workspaceId, action],
  );
  return result.rows[0]?.count;
}
async function pausePeriodCount(scope: Scope) {
  const result = await admin.query<{ count: number }>(
    'select count(*)::int as count from app.workflow_trigger_pause_periods where workspace_id=$1 and workflow_id=$2',
    [scope.workspaceId, scope.workflowId],
  );
  return result.rows[0]?.count;
}
async function waitForBlocked(pid: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await admin.query<{ waiting: boolean }>(
      'select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting',
      [pid],
    );
    if (result.rows[0]?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Expected database lock waiter');
}
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
    ).rejects.toBeInstanceOf(WorkflowIdempotencyConflictError);
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
    await fold.foldPending(1000, true);
    expect(await failures(scope)).toBe(0);
    for (let index = 0; index < 3; index++)
      await outcome(scope, new Date(Date.now() + 1000 + index).toISOString());
    await fold.foldPending(1000, true);
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
    await fold.foldPending(1000, true);
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
      const pendingFold = fold.foldPending(1000, true);
      await waitForBlocked(pid);
      await blocker.query(
        "select set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
        [scope.workspaceId, scope.actorId],
      );
      await blocker.query(
        `select app.workflow_auto_pause_control($1,$2,$3,'resume',$4::jsonb,$5,$6,null,null)`,
        [
          scope.workspaceId,
          scope.actorId,
          scope.workflowId,
          JSON.stringify({ expectedPauseRevision: '2' }),
          'a'.repeat(64),
          'b'.repeat(64),
        ],
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
  it('never grants direct streak/receipt authority and rejects malformed direct commands', async () => {
    const scope = await seed();
    await expect(
      api.query('select * from app.workflow_failure_streaks'),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      api.query('select * from app.workflow_auto_pause_command_receipts'),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      worker.query(
        `select app.workflow_auto_pause_control($1,$2,$3,'read','{}',null,null,null,null)`,
        [scope.workspaceId, scope.actorId, scope.workflowId],
      ),
    ).rejects.toThrow('auto pause context denied');
    const client = await api.connect();
    try {
      for (const request of [
        { expectedPauseRevision: null },
        {},
        { expectedPauseRevision: '1', unknown: true },
      ]) {
        await client.query('begin');
        await client.query(
          "select set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
          [scope.workspaceId, scope.actorId],
        );
        await expect(
          client.query(
            `select app.workflow_auto_pause_control($1,$2,$3,'resume',$4::jsonb,$5,$6,null,null)`,
            [
              scope.workspaceId,
              scope.actorId,
              scope.workflowId,
              JSON.stringify(request),
              'a'.repeat(64),
              'b'.repeat(64),
            ],
          ),
        ).rejects.toThrow(/invalid auto pause request/u);
        await client.query('rollback');
      }
    } finally {
      client.release();
    }
    await expect(
      controls().resumeWorkflow({
        ...scope,
        expectedPauseRevision: '0',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      controls().resumeWorkflow({
        ...scope,
        expectedPauseRevision: '9223372036854775808',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow();
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
      await fold.foldPending(1000, true);
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
        const pending = fold.foldPending(1000, true);
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
      "update app.workflow_auto_pause_command_receipts set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1",
      [scope.workspaceId],
    );
    const removed = await enforceRetention(maintenanceUrl);
    expect(removed.auto_pause_command_receipts).toBe(1);
    expect(
      (
        await admin.query(
          'select 1 from app.workflow_auto_pause_command_receipts where workspace_id=$1',
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
