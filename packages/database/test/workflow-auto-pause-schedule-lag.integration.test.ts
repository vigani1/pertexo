import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorkflowAuthoringDatabase } from '../src/authoring/workflow-authoring.js';
import { parseDatabaseConfig } from '../src/config.js';
import { createScheduleTriggerTestEnvironment } from './support/schedule-triggers.integration.support.js';

// Every scenario is relative to PostgreSQL's clock; no occurrence-time waits,
// external calls, production roles or shared development database are used.
const fixture = createScheduleTriggerTestEnvironment();
const { actorId, workspaceId, workflowId, ownerQuery, checkpointFactory } =
  fixture;
const triggerId = randomUUID();
let authoring: ReturnType<typeof createWorkflowAuthoringDatabase>;
let observer: Pool;
beforeAll(async () => {
  await fixture.initialize();
  authoring = createWorkflowAuthoringDatabase(
    parseDatabaseConfig({
      connectionString: fixture.apiConnectionString,
      max: 2,
    }),
  );
  const adminUrl = new URL(
    process.env.DATABASE_ADMIN_URL ??
      'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres',
  );
  adminUrl.pathname = new URL(fixture.apiConnectionString).pathname;
  observer = new Pool({ connectionString: adminUrl.toString(), max: 2 });
}, 60_000);
function closeAuthoring(value: { close(): Promise<void> } | undefined) {
  return value?.close();
}
function closeObserver(value: Pool | undefined) {
  return value?.end();
}
afterAll(async () => {
  await Promise.all([closeAuthoring(authoring), closeObserver(observer)]);
  await fixture.close();
});
const scope = { actorId, workspaceId, workflowId };
function controls() {
  const value = authoring.autoPause;
  if (value === undefined) throw new Error('Missing auto pause commands');
  return value;
}
async function pause(pausedAt?: string) {
  const result = await ownerQuery<{ revision: string }>(
    `update app.workflows set trigger_pause_state='paused',
    trigger_paused_at=coalesce($3::timestamptz,clock_timestamp()-interval '3 minutes'),
    trigger_pause_reason='consecutive_failures',trigger_pause_failures=10,trigger_pause_last_run_id=gen_random_uuid(),
    trigger_pause_revision=trigger_pause_revision+1 where workspace_id=$1 and id=$2
    returning trigger_pause_revision::text as revision`,
    [workspaceId, workflowId, pausedAt ?? null],
  );
  const revision = result.rows[0]?.revision;
  if (revision === undefined) throw new Error('Missing pause revision');
  return revision;
}
async function resume(revision: string, key = randomUUID()) {
  return controls().resumeWorkflow({
    ...scope,
    expectedPauseRevision: revision,
    idempotencyKey: key,
  });
}
async function configure(
  id: string,
  due?: string,
  enabled = true,
  policy: 'catch_up_once' | 'skip' = 'catch_up_once',
) {
  await ownerQuery(
    "update app.trigger_schedules set status='disabled',lease_owner=null,lease_token=null,lease_acquired_at=null,lease_expires_at=null where workspace_id=$1",
    [workspaceId],
  );
  const fingerprint = `trigger:v1:sha256:${createHash('sha256').update(id).digest('hex')}`;
  await ownerQuery(
    `insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,
    node_id,kind,status,desired_config,config_fingerprint,health_status)
    values($1,$2,$3,$4,$5,'schedule','active',$6::jsonb,$7,'healthy') on conflict(id) do nothing`,
    [
      id,
      workspaceId,
      workflowId,
      fixture.versionId,
      `lag-${id}`,
      JSON.stringify({
        kind: 'interval',
        intervalMinutes: 60,
        misfirePolicy: policy,
      }),
      fingerprint,
    ],
  );
  const result = await ownerQuery<{ due: string }>(
    `with instant as(select coalesce($5::timestamptz,date_trunc('milliseconds',clock_timestamp()-interval '2 minutes')) due)
    insert into app.trigger_schedules(trigger_id,workspace_id,recurrence_kind,interval_minutes,misfire_policy,status,
      config_fingerprint,anchor_at,next_fire_at)
    select $2,$1,'interval',60,$3,$4,$6,instant.due-interval '60 minutes',instant.due from instant
    on conflict(trigger_id) do update set status=excluded.status,next_fire_at=excluded.next_fire_at,last_fire_at=null
    returning to_char(next_fire_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as due`,
    [
      workspaceId,
      id,
      policy,
      enabled ? 'enabled' : 'disabled',
      due ?? null,
      fingerprint,
    ],
  );
  const value = result.rows[0]?.due;
  if (value === undefined) throw new Error('Missing due instant');
  return value;
}
async function scan() {
  return fixture.scannerOne.scanDue({
    leaseOwner: `lag-${randomUUID()}`,
    limit: 1,
    leaseSeconds: 30,
    onTimeWindowSeconds: 300,
    checkpointFactory,
  });
}
async function runs() {
  return (
    await ownerQuery<{ count: number }>(
      'select count(*)::integer as count from app.workflow_runs where workspace_id=$1 and workflow_id=$2',
      [workspaceId, workflowId],
    )
  ).rows[0]?.count;
}
async function latestPeriod() {
  const row = (
    await ownerQuery<{ revision: string; paused: string; resumed: string }>(
      `select pause_revision::text revision,
    to_char(paused_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') paused,
    to_char(resumed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') resumed
    from app.workflow_trigger_pause_periods where workspace_id=$1 and workflow_id=$2 order by pause_revision desc limit 1`,
      [workspaceId, workflowId],
    )
  ).rows[0];
  if (row === undefined) throw new Error('Missing completed pause period');
  return row;
}
async function claim() {
  const client = await fixture.worker.connect();
  try {
    const row = (
      await client.query<{ trigger_id: string; lease_token: string }>(
        'select trigger_id,lease_token from app.claim_due_trigger_schedules($1,1,30)',
        [`lag-claim-${randomUUID()}`],
      )
    ).rows[0];
    if (row === undefined) throw new Error('Missing schedule lease');
    return row;
  } finally {
    client.release();
  }
}
async function release(value: { trigger_id: string; lease_token: string }) {
  const client = await fixture.worker.connect();
  try {
    await client.query('select app.release_trigger_schedule_claim($1,$2)', [
      value.trigger_id,
      value.lease_token,
    ]);
  } finally {
    client.release();
  }
}
async function waitBlocked(blockerPid: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await observer.query<{ waiting: boolean }>(
      'select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) waiting',
      [blockerPid],
    );
    if (result.rows[0]?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Expected command to wait for the admission lock');
}

describe('paused schedule admission after resume and scanner lag', () => {
  it.each(['catch_up_once', 'skip'] as const)(
    'never admits an hourly %s occurrence that fell due during a completed pause',
    async (policy) => {
      const id = randomUUID();
      const due = await configure(id, undefined, true, policy);
      const before = await runs();
      await resume(await pause());
      expect((await controls().readWorkflowSettings(scope)).pauseState).toBe(
        'none',
      );
      expect(await scan()).toMatchObject({
        claimed: 1,
        accepted: 0,
        paused: 1,
        skipped: 0,
      });
      expect(await runs()).toBe(before);
      expect(
        (
          await ownerQuery(
            `select disposition,workflow_run_id from app.trigger_schedule_occurrences
      where workspace_id=$1 and trigger_id=$2 and scheduled_at=$3::timestamptz`,
            [workspaceId, id, due],
          )
        ).rows,
      ).toEqual([{ disposition: 'paused', workflow_run_id: null }]);
      expect(
        (
          await ownerQuery<{ advanced: boolean }>(
            'select next_fire_at>clock_timestamp() advanced from app.trigger_schedules where trigger_id=$1',
            [id],
          )
        ).rows[0]?.advanced,
      ).toBe(true);

      // The next actual due instant outside the closed pause is accepted under
      // either policy. Millisecond rounding stays safely after the SQL cut.
      const future = (
        await ownerQuery<{ due: string }>(
          `select to_char((resumed_at+interval '1 millisecond') at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') due from app.workflow_trigger_pause_periods
      where workspace_id=$1 and workflow_id=$2 order by pause_revision desc limit 1`,
          [workspaceId, workflowId],
        )
      ).rows[0]?.due;
      if (future === undefined) throw new Error('Missing post-resume instant');
      // A fresh future-anchored schedule demonstrates admission outside the
      // pause without changing an existing immutable recurrence or clock.
      await configure(randomUUID(), future, true, policy);
      expect(await scan()).toMatchObject({
        claimed: 1,
        accepted: 1,
        paused: 0,
      });
      expect(await runs()).toBe((before ?? 0) + 1);
    },
  );

  it('keeps older completed pause intervals through repeated cycles, replay, no-op, and disabled schedule lag', async () => {
    const due = await configure(triggerId, undefined, false);
    const revision = await pause();
    const key = randomUUID();
    const accepted = await resume(revision, key);
    const first = await latestPeriod();
    await resume(accepted.settings.pauseRevision);
    expect(await resume(revision, key)).toEqual({
      ...accepted,
      replayed: true,
    });
    expect(
      (
        await ownerQuery(
          'select 1 from app.workflow_trigger_pause_periods where workspace_id=$1 and workflow_id=$2 and pause_revision=$3::bigint',
          [workspaceId, workflowId, first.revision],
        )
      ).rows,
    ).toHaveLength(1);
    expect(await scan()).toMatchObject({ claimed: 0, accepted: 0, paused: 0 });
    const secondStart = (
      await ownerQuery<{ instant: string }>(
        'select to_char(clock_timestamp() at time zone \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') instant',
      )
    ).rows[0]?.instant;
    if (secondStart === undefined)
      throw new Error('Missing second pause start');
    await resume(await pause(secondStart));
    const second = await latestPeriod();
    expect(second.revision).not.toBe(first.revision);
    await configure(triggerId, due);
    const before = await runs();
    expect(await scan()).toMatchObject({ accepted: 0, paused: 1 });
    expect(await runs()).toBe(before);
    // No broad API or worker table reads are required for the admission gate.
    await expect(
      fixture.worker.query('select * from app.workflow_trigger_pause_periods'),
    ).rejects.toThrow(/permission denied/u);
    const api = new Pool({
      connectionString: fixture.apiConnectionString,
      max: 1,
    });
    try {
      await expect(
        api.query('select * from app.workflow_trigger_pause_periods'),
      ).rejects.toThrow(/permission denied/u);
    } finally {
      await api.end();
    }
  });

  it('uses exact SQL pause boundaries: the start is paused and the resume instant is outside', async () => {
    await configure(randomUUID());
    await resume(await pause());
    const period = await latestPeriod();
    const beforeFirst = (
      await ownerQuery<{ instant: string }>(
        `select to_char((min(paused_at)-interval '1 microsecond') at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') instant
          from app.workflow_trigger_pause_periods where workspace_id=$1 and workflow_id=$2`,
        [workspaceId, workflowId],
      )
    ).rows[0]?.instant;
    if (beforeFirst === undefined) throw new Error('Missing pre-pause instant');
    const lease = await claim();
    try {
      const client = await fixture.worker.connect();
      try {
        for (const [instant, expected] of [
          [beforeFirst, false],
          [period.paused, true],
          [period.resumed, false],
        ] as const) {
          expect(
            (
              await client.query<{ paused: boolean }>(
                'select app.schedule_claim_workflow_paused($1,$2,$3::timestamptz) paused',
                [lease.trigger_id, lease.lease_token, instant],
              )
            ).rows[0]?.paused,
          ).toBe(expected);
        }
      } finally {
        client.release();
      }
    } finally {
      await release(lease);
    }
  });

  it('keeps a paused admission decision valid while a resume waits on its workflow share lock', async () => {
    const due = await configure(randomUUID());
    const revision = await pause();
    const lease = await claim();
    const admission = await fixture.worker.connect();
    let pending: ReturnType<typeof resume> | undefined;
    try {
      await admission.query('begin');
      const pid = (
        await admission.query<{ pid: number }>('select pg_backend_pid() pid')
      ).rows[0]?.pid;
      if (pid === undefined) throw new Error('Missing admission pid');
      expect(
        (
          await admission.query<{ paused: boolean }>(
            'select app.schedule_claim_workflow_paused($1,$2,$3::timestamptz) paused',
            [lease.trigger_id, lease.lease_token, due],
          )
        ).rows[0]?.paused,
      ).toBe(true);
      pending = resume(revision);
      await waitBlocked(pid);
      await admission.query('commit');
      expect((await pending).settings.pauseState).toBe('none');
      expect(
        (
          await admission.query<{ paused: boolean }>(
            'select app.schedule_claim_workflow_paused($1,$2,$3::timestamptz) paused',
            [lease.trigger_id, lease.lease_token, due],
          )
        ).rows[0]?.paused,
      ).toBe(true);
    } finally {
      await admission.query('rollback');
      admission.release();
      await pending;
      await release(lease);
    }
  });
  it('sees the committed interval after admission waits on an in-progress resume', async () => {
    const due = await configure(randomUUID());
    const revision = await pause();
    const lease = await claim();
    const resuming = await observer.connect();
    let pending: Promise<{ rows: { paused: boolean }[] }> | undefined;
    try {
      await resuming.query('begin');
      await resuming.query('set local role pertexo_app');
      await resuming.query(
        "select set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
        [workspaceId, actorId],
      );
      const pid = (
        await resuming.query<{ pid: number }>('select pg_backend_pid() pid')
      ).rows[0]?.pid;
      if (pid === undefined) throw new Error('Missing resuming pid');
      // Invoke the real authenticated owner command but hold its commit, so
      // the admission's workflow SHARE lock has to wait for the cleared state.
      await resuming.query(
        `select app.workflow_auto_pause_control($1,$2,$3,'resume',$4::jsonb,$5,$6,null,null)`,
        [
          workspaceId,
          actorId,
          workflowId,
          JSON.stringify({ expectedPauseRevision: revision }),
          'd'.repeat(64),
          'e'.repeat(64),
        ],
      );
      pending = fixture.worker.query<{ paused: boolean }>(
        'select app.schedule_claim_workflow_paused($1,$2,$3::timestamptz) paused',
        [lease.trigger_id, lease.lease_token, due],
      );
      await waitBlocked(pid);
      await resuming.query('commit');
      expect((await pending).rows[0]?.paused).toBe(true);
      expect((await controls().readWorkflowSettings(scope)).pauseState).toBe(
        'none',
      );
    } finally {
      await resuming.query('rollback');
      resuming.release();
      await pending;
      await release(lease);
    }
  });
});
