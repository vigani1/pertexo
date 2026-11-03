import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  migrateDatabase,
  parseDatabaseConfig,
  createDisposableDatabaseFixture,
} from '@pertexo/database/testing';
import { createIdentityWorkspaceStore } from '../../src/testing.js';
import { createWorkflowTriggerPauseFoldStore } from '../../src/triggers/pause/fold.store.js';
import { createRetentionStore } from '../../src/lifecycle/retention/retention.store.js';
import { persistWorkflowTriggerOutcome } from '../../src/triggers/pause/outcomes.repository.js';

type Status =
  'succeeded' | 'failed' | 'timed_out' | 'outcome_unknown' | 'canceled';
type Trigger = 'schedule' | 'webhook' | 'manual' | 'api' | 'replay';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
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

const maintenanceUrl = url(
  'DATABASE_MAINTENANCE_URL',
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
);

let identity: ReturnType<typeof createIdentityWorkspaceStore>;
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
  identity = createIdentityWorkspaceStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  );
  fold = createWorkflowTriggerPauseFoldStore(
    parseDatabaseConfig({ connectionString: maintenanceUrl, max: 6 }),
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
    hadWaitingStep?: boolean;
    endedAt?: string;
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
      hadWaitingStep: options.hadWaitingStep ?? false,
      plan: {
        checkpoint: { runStatus: status },
        events: [
          {
            name: `run.${status}`,
            sequence: 7,
            occurredAt: options.endedAt ?? new Date(clock).toISOString(),
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

async function drain() {
  const decisions = [];
  for (let round = 0; round < 50; round += 1) {
    const batch = await fold.foldPending(1_000);
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
      { workspaceId, workflowId, consecutiveFailures: 12 },
    ]);
    expect(await pauseState(workspaceId, workflowId)).toEqual({
      state: 'paused',
      failures: 12,
      last_run: runs[11],
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
          failures: 12,
          threshold: 10,
          lastRunId: runs[11],
        },
      },
    ]);
    await endMany(workspaceId, workflowId, 'timed_out', 3);
    expect(await drain()).toEqual([]);
    expect(await pauseAudits(workspaceId)).toHaveLength(1);
  });

  it('does not charge the workflow for a run that timed out with nothing running', async () => {
    const { workspaceId, workflowId } = await seed();
    await end(workspaceId, workflowId, 'timed_out');
    await end(workspaceId, workflowId, 'timed_out', { hadWaitingStep: true });
    expect(await pending(workspaceId)).toBe(1);
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

  it('ignores failures that arrive in later batches but ended before the latest success', async () => {
    const { workspaceId, workflowId } = await seed();
    await end(workspaceId, workflowId, 'succeeded', {
      endedAt: '2026-10-01T04:00:00.000Z',
    });
    await drain();
    for (let hour = 1; hour <= 3; hour += 1) {
      await end(workspaceId, workflowId, 'failed', {
        endedAt: `2026-10-01T0${String(hour)}:00:00.000Z`,
      });
      expect(await drain()).toEqual([]);
    }
    expect(await streak(workspaceId, workflowId)).toBe(0);
    expect((await pauseState(workspaceId, workflowId))?.state).toBe('none');
    expect(await pauseAudits(workspaceId)).toEqual([]);
  });

  it('retains later failures when an earlier success arrives in a subsequent batch', async () => {
    const { workspaceId, workflowId } = await seed();
    await end(workspaceId, workflowId, 'failed', {
      endedAt: '2026-10-01T03:00:00.000Z',
    });
    await end(workspaceId, workflowId, 'failed', {
      endedAt: '2026-10-01T05:00:00.000Z',
    });
    await drain();
    await end(workspaceId, workflowId, 'succeeded', {
      endedAt: '2026-10-01T02:00:00.000Z',
    });
    expect(await drain()).toEqual([]);
    expect(await streak(workspaceId, workflowId)).toBe(2);
    await end(workspaceId, workflowId, 'succeeded', {
      endedAt: '2026-10-01T04:00:00.000Z',
    });
    await drain();
    expect(await streak(workspaceId, workflowId)).toBe(1);
    await end(workspaceId, workflowId, 'failed', {
      endedAt: '2026-10-01T04:30:00.000Z',
    });
    await drain();
    expect(await streak(workspaceId, workflowId)).toBe(2);
    expect((await pauseState(workspaceId, workflowId))?.state).toBe('none');
  });

  it('does not pause for a threshold crossed before a later success in the same batch', async () => {
    const { workspaceId, workflowId } = await seed();
    await endMany(workspaceId, workflowId, 'failed', 10);
    await end(workspaceId, workflowId, 'succeeded');
    expect(await drain()).toEqual([]);
    expect(await streak(workspaceId, workflowId)).toBe(0);
    expect(await pauseAudits(workspaceId)).toEqual([]);
  });

  it('has the same recovered pause state with a success just beyond the batch limit', async () => {
    const states = [];
    for (const limit of [10, 1000]) {
      const { workspaceId, workflowId } = await seed();
      await endMany(workspaceId, workflowId, 'failed', 10);
      await end(workspaceId, workflowId, 'succeeded');
      expect(await fold.foldPending(limit)).toEqual([]);
      expect(await pending(workspaceId)).toBe(limit === 10 ? 1 : 0);
      expect((await pauseState(workspaceId, workflowId))?.state).toBe('none');
      await drain();
      states.push({
        state: (await pauseState(workspaceId, workflowId))?.state,
        streak: await streak(workspaceId, workflowId),
        audits: await pauseAudits(workspaceId),
      });
    }
    expect(states).toEqual([
      { state: 'none', streak: 0, audits: [] },
      { state: 'none', streak: 0, audits: [] },
    ]);
  });

  it('extends an upgrade carry until the first success, retaining failures that ended after that success', async () => {
    const { workspaceId, workflowId } = await seed();
    await asAdmin(
      'insert into app.workflow_failure_streaks(workspace_id,workflow_id,consecutive_failures,legacy_failures) values($1,$2,7,7)',
      [workspaceId, workflowId],
    );
    await end(workspaceId, workflowId, 'failed', {
      endedAt: '2026-10-01T03:00:00.000Z',
    });
    await drain();
    expect(await streak(workspaceId, workflowId)).toBe(8);
    await end(workspaceId, workflowId, 'succeeded', {
      endedAt: '2026-10-01T02:00:00.000Z',
    });
    await drain();
    expect(await streak(workspaceId, workflowId)).toBe(1);
    expect((await pauseState(workspaceId, workflowId))?.state).toBe('none');
  });

  it('preserves microseconds and uses the outcome UUID only to break equal completion times', async () => {
    for (const equalTime of [false, true]) {
      const { workspaceId, workflowId } = await seed();
      const earlier = await end(workspaceId, workflowId, 'failed', {
        endedAt: '2026-10-01T04:00:00.123455Z',
      });
      const success = await end(workspaceId, workflowId, 'succeeded', {
        endedAt: '2026-10-01T04:00:00.123455Z',
      });
      const later = await end(workspaceId, workflowId, 'failed', {
        endedAt: equalTime
          ? '2026-10-01T04:00:00.123455Z'
          : '2026-10-01T04:00:00.123456Z',
      });
      const positions = [randomUUID(), randomUUID(), randomUUID()].sort();
      // If microseconds are lost, this later failure sorts before the success.
      for (const [runId, id] of [
        [earlier, positions[0]],
        [success, positions[equalTime ? 1 : 2]],
        [later, positions[equalTime ? 2 : 1]],
      ])
        await asAdmin(
          'update app.workflow_trigger_outcomes set id=$2 where run_id=$1',
          [runId, id],
        );
      await drain();
      expect(await streak(workspaceId, workflowId)).toBe(1);
      expect(await pauseAudits(workspaceId)).toEqual([]);
    }
  });

  it('retains the relevant failure suffix after maintenance and deletion of its run summary', async () => {
    const { workspaceId, workflowId } = await seed();
    const oldRun = await end(workspaceId, workflowId, 'failed', {
      endedAt: '2026-10-01T01:00:00.000Z',
    });
    const retainedRun = await end(workspaceId, workflowId, 'failed', {
      endedAt: '2026-10-01T03:00:00.000Z',
    });
    await drain();
    await end(workspaceId, workflowId, 'succeeded', {
      endedAt: '2026-10-01T02:00:00.000Z',
    });
    await drain();
    const retention = createRetentionStore(
      parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
    );
    try {
      await retention.enforce();
    } finally {
      await retention.close();
    }
    expect(
      await asAdmin(
        'select run_id from app.workflow_trigger_failures where workflow_id=$1',
        [workflowId],
      ),
    ).toEqual([{ run_id: retainedRun }]);
    await asAdmin('delete from app.workflow_runs where id=any($1::uuid[])', [
      [oldRun, retainedRun],
    ]);
    expect(
      await asAdmin(
        'select run_id from app.workflow_trigger_failures where workflow_id=$1',
        [workflowId],
      ),
    ).toEqual([{ run_id: retainedRun }]);
    await end(workspaceId, workflowId, 'failed', {
      endedAt: '2026-10-01T04:00:00.000Z',
    });
    await drain();
    expect(await streak(workspaceId, workflowId)).toBe(2);
  });

  it('rolls back queue consumption, streak, pause and audit together, then retries once', async () => {
    const { workspaceId, workflowId } = await seed();
    await endMany(workspaceId, workflowId, 'failed', 10);
    await asAdmin(`create function public.reject_pause_audit() returns trigger language plpgsql as $$
      begin if NEW.action='workflow.triggers_paused' then raise exception 'Pause audit unavailable'; end if; return NEW; end $$;
      create trigger reject_pause_audit before insert on app.audit_events for each row execute function public.reject_pause_audit()`);
    try {
      await expect(fold.foldPending(1000)).rejects.toThrow();
      expect(await pending(workspaceId)).toBe(10);
      expect(await streak(workspaceId, workflowId)).toBeUndefined();
      expect((await pauseState(workspaceId, workflowId))?.state).toBe('none');
      expect(await pauseAudits(workspaceId)).toEqual([]);
      expect(
        await asAdmin(
          'select * from app.workflow_trigger_failures where workflow_id=$1',
          [workflowId],
        ),
      ).toEqual([]);
    } finally {
      await asAdmin(
        'drop trigger reject_pause_audit on app.audit_events; drop function public.reject_pause_audit()',
      );
    }
    expect(await drain()).toHaveLength(1);
    expect(await pending(workspaceId)).toBe(0);
    expect(await streak(workspaceId, workflowId)).toBe(10);
    expect(await pauseAudits(workspaceId)).toHaveLength(1);
    expect(await drain()).toEqual([]);
  });

  it('never pauses twice across concurrent folds of a burst', async () => {
    const { workspaceId, workflowId } = await seed();
    await endMany(workspaceId, workflowId, 'failed', 40);
    const rounds = await Promise.all(
      Array.from({ length: 4 }, () => fold.foldPending(7)),
    );
    await drain();
    expect(rounds.flat().length).toBeLessThanOrEqual(1);
    expect(await pauseAudits(workspaceId)).toHaveLength(1);
    expect(await streak(workspaceId, workflowId)).toBe(40);
    expect(await pending(workspaceId)).toBe(0);
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

  it.each([false, true])(
    'records the latest failed run after compaction with a late success=%s',
    async (lateSuccess) => {
      const { workspaceId, workflowId } = await seed();
      await asAdmin(
        'update app.workflows set auto_pause_enabled=false where id=$1',
        [workflowId],
      );
      const base = Date.parse('2026-10-01T00:00:00.000Z');
      for (let n = 1; n <= 150; n++)
        await end(workspaceId, workflowId, 'failed', {
          endedAt: new Date(base + n * 1000).toISOString(),
        });
      expect(await drain()).toEqual([]);
      if (lateSuccess) {
        await end(workspaceId, workflowId, 'succeeded', {
          endedAt: new Date(base + 25_500).toISOString(),
        });
        expect(await drain()).toEqual([]);
      }
      await asAdmin(
        'update app.workflows set auto_pause_enabled=true,auto_pause_threshold=10 where id=$1',
        [workflowId],
      );
      const latest = await end(workspaceId, workflowId, 'failed', {
        endedAt: new Date(base + 151_000).toISOString(),
      });
      await drain();
      expect(await pauseState(workspaceId, workflowId)).toEqual({
        state: 'paused',
        failures: 100,
        last_run: latest,
        revision: '2',
      });
      expect(await pauseAudits(workspaceId)).toEqual([
        {
          target_id: workflowId,
          metadata: {
            reason: 'consecutive_failures',
            failures: 100,
            threshold: 10,
            lastRunId: latest,
          },
        },
      ]);
    },
  );

  it('bounds disabled failure storage and fold reads after thousands of failures', async () => {
    const { workspaceId, workflowId } = await seed();
    await asAdmin('create extension if not exists pg_stat_statements');
    await asAdmin(
      'update app.workflows set auto_pause_enabled=false where id=$1',
      [workflowId],
    );
    const reads = async () => {
      const [row] = await asAdmin<{ blocks: number }>(
        `select coalesce(sum(shared_blks_hit+shared_blks_read),0)::int blocks
         from pg_stat_statements where dbid=(select oid from pg_database where datname=current_database())
         and query like 'select%workflow_trigger_failures%'`,
      );
      return row?.blocks ?? 0;
    };
    // Folded positions outlive run summaries; seed that retained history directly
    // instead of measuring thousands of unrelated run-admission transactions.
    const history = async (count: number, offset: number) =>
      asAdmin(
        `insert into app.workflow_trigger_failures(id,workspace_id,workflow_id,run_id,ended_at)
       select gen_random_uuid(),$1,$2,gen_random_uuid(),'2026-10-01'::timestamptz+($3::int+n)*interval '1 second'
       from generate_series(1,$4::int) n`,
        [workspaceId, workflowId, offset, count],
      );
    const measureFold = async (second: number) => {
      await end(workspaceId, workflowId, 'failed', {
        endedAt: new Date(
          Date.parse('2026-10-01T00:00:00Z') + second * 1000,
        ).toISOString(),
      });
      // Compare live evidence independently of vacuum scheduling and stats flushing.
      await asAdmin('vacuum (analyze) app.workflow_trigger_failures');
      const measuredFold = createWorkflowTriggerPauseFoldStore(
        parseDatabaseConfig({ connectionString: maintenanceUrl, max: 1 }),
      );
      const before = await reads();
      try {
        expect(await measuredFold.foldPending(1000)).toEqual([]);
      } finally {
        await measuredFold.close();
      }
      return (await reads()) - before;
    };
    await history(100, 0);
    const small = await measureFold(101);
    await history(5000, 101);
    const large = await measureFold(5102);
    const retention = createRetentionStore(
      parseDatabaseConfig({ connectionString: maintenanceUrl, max: 1 }),
    );
    try {
      await retention.enforce();
    } finally {
      await retention.close();
    }
    const [retained] = await asAdmin<{ count: number }>(
      'select count(*)::int count from app.workflow_trigger_failures where workflow_id=$1',
      [workflowId],
    );
    expect.soft(retained?.count).toBe(100);
    expect.soft(small).toBeLessThanOrEqual(16);
    expect.soft(large).toBeLessThanOrEqual(16);
    expect(large).toBeLessThanOrEqual(small + 4);
    expect(await pending(workspaceId)).toBe(0);
    expect(await pauseAudits(workspaceId)).toEqual([]);
  });

  it('retains only the newest maximum-threshold evidence and preserves late success splits', async () => {
    const { workspaceId, workflowId } = await seed();
    const runs = await endMany(workspaceId, workflowId, 'failed', 150);
    expect(await drain()).toHaveLength(1);
    const positions = await asAdmin<{ run_id: string; ended_at: string }>(
      `select run_id,to_char(ended_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ended_at
       from app.workflow_trigger_failures where workflow_id=$1 order by ended_at,id`,
      [workflowId],
    );
    expect(positions.map((row) => row.run_id)).toEqual(runs.slice(-100));
    expect((await pauseState(workspaceId, workflowId))?.last_run).toBe(
      runs[149],
    );
    await end(workspaceId, workflowId, 'succeeded', {
      endedAt: new Date(
        Date.parse(positions[50]?.ended_at ?? '') + 500,
      ).toISOString(),
    });
    await drain();
    expect(await streak(workspaceId, workflowId)).toBe(49);
    const remaining = await asAdmin<{ run_id: string }>(
      'select run_id from app.workflow_trigger_failures where workflow_id=$1 order by ended_at,id',
      [workflowId],
    );
    expect(remaining.map((row) => row.run_id)).toEqual(runs.slice(-49));
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
           (id,workspace_id,endpoint_id,outcome,http_status,
            signature_check,replay_check)
         values ($1,$2,$3,'paused',409,'verified','new')`,
        [randomUUID(), workspaceId, randomUUID()],
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
