import { waitForBlockedBy } from '../../../support/postgres/lock-coordination.js';
import { createHash, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';

import { createWorkflowAuthoringDatabase } from '../../../../src/authoring/workflows/store.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { databaseSchema } from '@pertexo/database/schema';
import {
  parseWorkspaceId,
  withWorkspaceTransaction,
} from '@pertexo/database/primitives';
import { claimedScheduleWorkflowPaused } from '../../../../src/triggers/schedules/pause.queries.js';
import { createScheduleTriggerTestEnvironment } from '../../../support/schedule-triggers.js';
import { testExecutableCompiler } from '../../../../src/authoring/test-executable-compiler.js';

// Every scenario is relative to PostgreSQL's clock; no occurrence-time waits,
// external calls, production roles or shared development database are used.
export const fixture = createScheduleTriggerTestEnvironment();

export const {
  actorId,
  workspaceId,
  workflowId,
  ownerQuery,
  checkpointFactory,
} = fixture;

export const triggerId = randomUUID();

let authoring: ReturnType<typeof createWorkflowAuthoringDatabase>;

export let observer: Pool;

function closeAuthoring(value: { close(): Promise<void> } | undefined) {
  return value?.close();
}

function closeObserver(value: Pool | undefined) {
  return value?.end();
}

export const scope = { actorId, workspaceId, workflowId };

type Lease = Readonly<{ trigger_id: string; lease_token: string }>;

/** Whether admission sees the instant as paused, in a new transaction. */
export function pausedAt(lease: Lease, instant: string) {
  return withWorkspaceTransaction(fixture.worker, workspaceId, (transaction) =>
    claimedScheduleWorkflowPaused(transaction, lease, new Date(instant)),
  );
}

/** The same check in a caller's open transaction, holding its locks. */
export async function pausedIn(
  client: PoolClient,
  lease: Lease,
  instant: string,
) {
  await client.query("select set_config('app.workspace_id',$1,true)", [
    workspaceId,
  ]);
  return claimedScheduleWorkflowPaused(
    {
      db: drizzle(client, { schema: databaseSchema }),
      workspaceId: parseWorkspaceId(workspaceId),
    },
    lease,
    new Date(instant),
  );
}

export function controls() {
  const value = authoring.autoPause;
  if (value === undefined) throw new Error('Missing auto pause commands');
  return value;
}

export async function pause(pausedAt?: string) {
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

export async function resume(revision: string, key = randomUUID()) {
  return controls().resumeWorkflow({
    ...scope,
    expectedPauseRevision: revision,
    idempotencyKey: key,
  });
}

export async function configure(
  id: string,
  due?: string,
  enabled = true,
  policy: 'catch_up_once' | 'skip' = 'catch_up_once',
) {
  await ownerQuery(
    "update app.trigger_schedules set status='disabled',lease_owner=null,lease_token=null,lease_acquired_at=null,lease_expires_at=null where workspace_id=$1",
    [workspaceId],
  );
  const fingerprint = `trigger:sha256:${createHash('sha256').update(id).digest('hex')}`;
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

export async function scan() {
  return fixture.scannerOne.scanDue({
    leaseOwner: `lag-${randomUUID()}`,
    limit: 1,
    leaseSeconds: 30,
    onTimeWindowSeconds: 300,
    checkpointFactory,
  });
}

export async function runs() {
  return (
    await ownerQuery<{ count: number }>(
      'select count(*)::integer as count from app.workflow_runs where workspace_id=$1 and workflow_id=$2',
      [workspaceId, workflowId],
    )
  ).rows[0]?.count;
}

export async function latestPeriod() {
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

export async function claim() {
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

export async function release(value: {
  trigger_id: string;
  lease_token: string;
}) {
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

export async function waitBlocked(blockerPid: number) {
  await waitForBlockedBy(observer, blockerPid);
}

export async function beforeAllFixture1() {
  await fixture.initialize();
  authoring = createWorkflowAuthoringDatabase(
    parseDatabaseConfig({
      connectionString: fixture.apiConnectionString,
      max: 2,
    }),
    { executableCompiler: testExecutableCompiler },
  );
  const adminUrl = new URL(
    process.env.DATABASE_ADMIN_URL ??
      'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres',
  );
  adminUrl.pathname = new URL(fixture.apiConnectionString).pathname;
  observer = new Pool({ connectionString: adminUrl.toString(), max: 2 });
}

export async function afterAllFixture2() {
  await Promise.all([closeAuthoring(authoring), closeObserver(observer)]);
  await fixture.close();
}
