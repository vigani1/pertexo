import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../src/migrations.js';
import {
  createIdentityWorkspaceDatabase,
  parseDatabaseConfig,
} from '../src/testing.js';
import { createWorkflowTriggerPauseFoldStore } from '../src/triggers/pause/fold-store.js';
import { persistWorkflowTriggerOutcome } from '../src/triggers/pause/outcome-producer.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

type Status =
  'succeeded' | 'failed' | 'timed_out' | 'outcome_unknown' | 'canceled';
type Trigger = 'schedule' | 'webhook' | 'manual' | 'api' | 'replay';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_app'],
  databaseName: `pertexo_test_trigger_pause_${randomUUID().replaceAll('-', '')}`,
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

let identity: ReturnType<typeof createIdentityWorkspaceDatabase>;
let fold: ReturnType<typeof createWorkflowTriggerPauseFoldStore>;
let admin: Pool;
let worker: Pool;

beforeAll(async () => {
  await fixture.create();
  await migrateDatabase({
    appRole: 'pertexo_app',
    connectionString: migrationUrl,
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
  });
  identity = createIdentityWorkspaceDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  );
  fold = createWorkflowTriggerPauseFoldStore(
    parseDatabaseConfig({ connectionString: workerUrl, max: 6 }),
  );
  admin = new Pool({ connectionString: fixture.databaseUrl(adminUrl), max: 2 });
  worker = new Pool({ connectionString: workerUrl, max: 2 });
}, 60_000);

afterAll(async () => {
  const closing = await Promise.allSettled([
    identity.close(),
    fold.close(),
    admin.end(),
    worker.end(),
  ]);
  await fixture.drop();
  const failure = closing.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
});

async function asAdmin<Row extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<Row[]> {
  return (await admin.query<Row>(text, values)).rows;
}

/** A workspace with one active workflow, able to admit many runs. */
async function seed() {
  const owner = (
    await identity.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Owner',
    })
  ).id;
  const workspaceId = (
    await identity.createWorkspaceWithOwner({
      name: 'Trigger pause',
      slug: `trigger-pause-${randomUUID().slice(0, 8)}`,
      ownerUserId: owner,
    })
  ).id;
  await asAdmin(
    `insert into app.workspace_execution_entitlement_versions
       (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
     values ($1,2,'active',10000,100000,'-infinity'::timestamptz)`,
    [workspaceId],
  );
  await asAdmin(
    'update app.workspace_execution_entitlements set current_version=2 where workspace_id=$1',
    [workspaceId],
  );
  const workflowId = randomUUID();
  await asAdmin(
    'insert into app.workflows (id,workspace_id,name,created_by) values ($1,$2,$3,$4)',
    [workflowId, workspaceId, 'Nightly import', owner],
  );
  return { workspaceId, workflowId };
}

let clock = Date.parse('2026-09-30T08:00:00.000Z');

/** A run that ended, recorded by the real producer as the worker role. */
async function end(
  workspaceId: string,
  workflowId: string,
  status: Status,
  options: Readonly<{
    trigger?: Trigger;
    cancellationRequested?: boolean;
    contextWorkspaceId?: string;
  }> = {},
) {
  const runId = randomUUID();
  const trigger = options.trigger ?? 'schedule';
  clock += 1_000;
  await asAdmin(
    `with tenant as (select set_config('app.workspace_id',$2::uuid::text,true))
     insert into app.workflow_runs (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
     select $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6 from tenant`,
    // A replay row needs lineage; the producer reads only the trigger it gets.
    [
      runId,
      workspaceId,
      workflowId,
      randomUUID(),
      trigger === 'replay' ? 'manual' : trigger,
      status,
    ],
  );
  const client = await worker.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      options.contextWorkspaceId ?? workspaceId,
    ]);
    await persistWorkflowTriggerOutcome(client, {
      workspaceId,
      workflowId,
      runId,
      triggerType: trigger,
      cancellationRequested: options.cancellationRequested ?? false,
      plan: {
        checkpoint: { runStatus: status },
        events: [
          {
            name: `run.${status}`,
            sequence: 7,
            occurredAt: new Date(clock).toISOString(),
          },
        ],
      } as never,
    });
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
  return runId;
}

async function endMany(
  workspaceId: string,
  workflowId: string,
  status: Status,
  count: number,
) {
  const runs: string[] = [];
  for (let index = 0; index < count; index += 1)
    runs.push(await end(workspaceId, workflowId, status));
  return runs;
}

async function pauseState(workspaceId: string, workflowId: string) {
  const [row] = await asAdmin<{
    state: string;
    failures: number | null;
    last_run: string | null;
    revision: string;
  }>(
    `select trigger_pause_state as state,trigger_pause_failures as failures,
            trigger_pause_last_run_id as last_run,trigger_pause_revision::text as revision
       from app.workflows where workspace_id=$1 and id=$2`,
    [workspaceId, workflowId],
  );
  return row;
}

async function streak(workspaceId: string, workflowId: string) {
  const [row] = await asAdmin<{ failures: number }>(
    `select consecutive_failures as failures from app.workflow_failure_streaks
      where workspace_id=$1 and workflow_id=$2`,
    [workspaceId, workflowId],
  );
  return row?.failures;
}

async function pending(workspaceId: string) {
  const [row] = await asAdmin<{ count: number }>(
    'select count(*)::int as count from app.workflow_trigger_outcomes where workspace_id=$1',
    [workspaceId],
  );
  return row?.count;
}

async function pauseAudits(workspaceId: string) {
  return asAdmin<{ target_id: string; metadata: Record<string, unknown> }>(
    `select target_id,metadata from app.audit_events
      where workspace_id=$1 and action='workflow.triggers_paused'`,
    [workspaceId],
  );
}

async function drain(enforce = true) {
  const decisions = [];
  for (let round = 0; round < 50; round += 1) {
    const batch = await fold.foldPending(1_000, enforce);
    decisions.push(...batch);
    if (
      (await asAdmin('select 1 from app.workflow_trigger_outcomes limit 1'))
        .length === 0
    )
      return decisions;
  }
  throw new Error('Pending outcomes did not drain');
}

describe('workflow trigger pause (ADR 056)', () => {
  it('accepts the reviewed fold command at startup', async () => {
    await expect(fold.checkReadiness()).resolves.toBeUndefined();
  });

  it('records only schedule and webhook outcomes, in the worker’s own workspace', async () => {
    const { workspaceId, workflowId } = await seed();
    const other = await seed();
    await end(workspaceId, workflowId, 'failed', { trigger: 'schedule' });
    await end(workspaceId, workflowId, 'succeeded', { trigger: 'webhook' });
    for (const trigger of ['manual', 'api', 'replay'] as const)
      await end(workspaceId, workflowId, 'failed', { trigger });
    await end(workspaceId, workflowId, 'failed', {
      cancellationRequested: true,
    });
    await end(workspaceId, workflowId, 'canceled');
    expect(await pending(workspaceId)).toBe(2);
    await expect(
      end(workspaceId, workflowId, 'failed', {
        contextWorkspaceId: other.workspaceId,
      }),
    ).rejects.toThrow(/row-level security/u);
    await expect(
      worker.query('select count(*) from app.workflow_trigger_outcomes'),
    ).rejects.toThrow(/permission denied/u);
  });

  it('pauses once at the threshold, with the reason, the streak and an audit fact', async () => {
    const { workspaceId, workflowId } = await seed();
    const runs = await endMany(workspaceId, workflowId, 'failed', 12);
    const decisions = await drain();
    expect(decisions).toEqual([
      { workspaceId, workflowId, consecutiveFailures: 10, paused: true },
    ]);
    expect(await pauseState(workspaceId, workflowId)).toEqual({
      state: 'paused',
      failures: 10,
      last_run: runs[9],
      revision: '2',
    });
    expect(await streak(workspaceId, workflowId)).toBe(12);
    expect(await pending(workspaceId)).toBe(0);
    const audits = await pauseAudits(workspaceId);
    expect(audits).toEqual([
      {
        target_id: workflowId,
        metadata: {
          reason: 'consecutive_failures',
          failures: 10,
          threshold: 10,
          lastRunId: runs[9],
        },
      },
    ]);
    await endMany(workspaceId, workflowId, 'timed_out', 3);
    expect(await drain()).toEqual([]);
    expect(await pauseAudits(workspaceId)).toHaveLength(1);
  });

  it('resets the streak on a success and counts unknown outcomes', async () => {
    const { workspaceId, workflowId } = await seed();
    await endMany(workspaceId, workflowId, 'failed', 8);
    await end(workspaceId, workflowId, 'succeeded');
    await endMany(workspaceId, workflowId, 'outcome_unknown', 9);
    expect(await drain()).toEqual([]);
    expect(await streak(workspaceId, workflowId)).toBe(9);
    expect((await pauseState(workspaceId, workflowId))?.state).toBe('none');
    await end(workspaceId, workflowId, 'failed');
    expect(await drain()).toHaveLength(1);
    expect((await pauseState(workspaceId, workflowId))?.state).toBe('paused');
  });

  it('never pauses twice across concurrent folds of a burst', async () => {
    const { workspaceId, workflowId } = await seed();
    await endMany(workspaceId, workflowId, 'failed', 40);
    const rounds = await Promise.all(
      Array.from({ length: 4 }, () => fold.foldPending(7, true)),
    );
    await drain();
    expect(
      rounds.flat().filter(({ paused }) => paused).length,
    ).toBeLessThanOrEqual(1);
    expect(await pauseAudits(workspaceId)).toHaveLength(1);
    expect(await streak(workspaceId, workflowId)).toBe(40);
    expect(await pending(workspaceId)).toBe(0);
  });

  it('only reports a would-be pause while observing', async () => {
    const { workspaceId, workflowId } = await seed();
    await endMany(workspaceId, workflowId, 'failed', 10);
    expect(await drain(false)).toEqual([
      { workspaceId, workflowId, consecutiveFailures: 10, paused: false },
    ]);
    expect((await pauseState(workspaceId, workflowId))?.state).toBe('none');
    expect(await pauseAudits(workspaceId)).toEqual([]);
  });

  it('honours the workflow override, the workspace default and opting out', async () => {
    const { workspaceId, workflowId } = await seed();
    await asAdmin(
      'update app.workspaces set auto_pause_threshold=5 where id=$1',
      [workspaceId],
    );
    await endMany(workspaceId, workflowId, 'failed', 5);
    expect(await drain()).toHaveLength(1);

    const override = await seed();
    await asAdmin(
      `update app.workflows set auto_pause_threshold=3
        where workspace_id=$1 and id=$2`,
      [override.workspaceId, override.workflowId],
    );
    await endMany(override.workspaceId, override.workflowId, 'failed', 3);
    expect(await drain()).toHaveLength(1);

    const optedOut = await seed();
    await asAdmin(
      `update app.workflows set auto_pause_enabled=false
        where workspace_id=$1 and id=$2`,
      [optedOut.workspaceId, optedOut.workflowId],
    );
    await endMany(optedOut.workspaceId, optedOut.workflowId, 'failed', 12);
    expect(await drain()).toEqual([]);
    expect(await streak(optedOut.workspaceId, optedOut.workflowId)).toBe(12);
  });

  it('leaves an archived workflow unpaused', async () => {
    const { workspaceId, workflowId } = await seed();
    await asAdmin(
      `update app.workflows set lifecycle_status='archived'
        where workspace_id=$1 and id=$2`,
      [workspaceId, workflowId],
    );
    await endMany(workspaceId, workflowId, 'failed', 10);
    expect(await drain()).toEqual([]);
    expect((await pauseState(workspaceId, workflowId))?.state).toBe('none');
  });

  it('binds the paused outcomes to no run and, for webhooks, to 423', async () => {
    const { workspaceId } = await seed();
    await expect(
      asAdmin(
        `insert into app.webhook_trigger_deliveries
           (id,workspace_id,trigger_id,endpoint_id,outcome,http_status,
            signature_check,replay_check)
         values ($1,$2,$3,$4,'paused',409,'verified','new')`,
        [randomUUID(), workspaceId, randomUUID(), randomUUID()],
      ),
    ).rejects.toThrow(/webhook_trigger_deliveries_outcome_valid/u);
    await expect(
      asAdmin(
        `insert into app.trigger_schedule_occurrences
           (id,workspace_id,trigger_id,scheduled_at,disposition,workflow_run_id)
         values ($1,$2,$3,clock_timestamp(),'paused',$4)`,
        [randomUUID(), workspaceId, randomUUID(), randomUUID()],
      ),
    ).rejects.toThrow(/trigger_schedule_occurrences_disposition_valid/u);
  });
});
