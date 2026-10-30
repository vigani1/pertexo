import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  explainDocument,
  explainWork,
  indexScans,
  type ExplainDocument,
} from '../support/postgres/query-plan.js';
import {
  superuserUrl,
  statisticsDatabase,
  runs,
  busyWorkspace,
  quietWorkspace,
  intake,
  elsewhere,
  inWorkspace,
  addWorkflows,
  addRuns,
  beforeAllFixture1,
  beforeEachFixture2,
  afterAllFixture3,
} from './statistics/fixture.js';
import { registerScalarReadInheritsBoundedStatement } from './statistics/scalar-read-inherits-bounded-statement.cases.js';
import { registerChargesPendingAvailableDeletingArtifacts } from './statistics/charges-pending-available-deleting-artifacts.cases.js';
import { registerExcludesTestsListsAllHistory } from './statistics/excludes-tests-lists-all-history.cases.js';
import { registerReturnsZerosIdleWorkspaceRejects } from './statistics/returns-zeros-idle-workspace-rejects.cases.js';
import { registerCountsLogicalTriggerSkipsSeparately } from './statistics/counts-logical-trigger-skips-separately.cases.js';
import { registerObservesStoragePerWorkspace } from './statistics/observes-storage-per-workspace.cases.js';
beforeAll(beforeAllFixture1);
beforeEach(beforeEachFixture2);
afterAll(afterAllFixture3);
describe('ADR 057 current capacity authority', () => {
  registerScalarReadInheritsBoundedStatement();

  registerChargesPendingAvailableDeletingArtifacts();

  registerObservesStoragePerWorkspace();
});
describe('workspace run statistics', () => {
  registerExcludesTestsListsAllHistory();

  registerReturnsZerosIdleWorkspaceRejects();
});
describe('run statistics query-plan budget', () => {
  // Production-shaped: most of the workspace's retained history lies outside
  // the requested window, and another workspace is busier still.
  async function seedHistory() {
    const workflows = Array.from(
      { length: 12 },
      (_, index) => [randomUUID(), `Plan workflow ${String(index)}`] as const,
    );
    await addWorkflows(busyWorkspace, workflows);
    await inWorkspace('api', busyWorkspace, {
      text: `insert into app.workflow_runs
         (id, workspace_id, workflow_id, workflow_version_id, trigger_type,
          status, created_at, updated_at)
       select gen_random_uuid(), $1, version.workflow_id, version.id,
              'schedule',
              (array['succeeded','failed','canceled','timed_out'])[1 + ordinal % 4],
              now() - make_interval(mins => ordinal * 7),
              now() - make_interval(mins => ordinal * 7)
       from app.workflow_versions version
       cross join generate_series(1, 160) ordinal
       where version.workspace_id = $1 and version.workflow_id = any($2::uuid[])`,
      values: [busyWorkspace, workflows.map(([id]) => id)],
    });
    await addRuns(quietWorkspace, elsewhere, {
      status: 'succeeded',
      count: 2_500,
      age: '30 minutes',
    });
  }

  async function vacuumStatisticsFixture(timeoutMillis = 5_000) {
    // A completed VACUUM cannot make newly inserted rows all-visible while
    // an older snapshot (including an autovacuum worker) is still alive.
    // Drain that fixture precondition, not the measured query's result.
    const superuser = new Pool({
      connectionString: statisticsDatabase.databaseUrl(superuserUrl),
      max: 1,
    });
    try {
      const deadline = Date.now() + timeoutMillis;
      for (;;) {
        const snapshots = await superuser.query<{ count: number }>(
          `select count(*)::integer as count from pg_stat_activity
           where datname = current_database() and pid <> pg_backend_pid()
             and backend_xmin is not null`,
        );
        if (snapshots.rows[0]?.count === 0) break;
        if (Date.now() >= deadline)
          throw new Error('Statistics fixture still has active snapshots');
        await delay(10);
      }
      await superuser.query('vacuum (analyze) app.workflow_runs');
      const visibility = await superuser.query<{
        relpages: number;
        relallvisible: number;
      }>(
        `select relpages, relallvisible from pg_class
         where oid = 'app.workflow_runs'::regclass`,
      );
      expect(visibility.rows[0]?.relpages).toBeGreaterThan(0);
      expect(visibility.rows[0]?.relallvisible).toBe(
        visibility.rows[0]?.relpages,
      );
    } finally {
      await superuser.end();
    }
  }

  async function explainAsApi(statement: string): Promise<ExplainDocument> {
    return explainDocument(
      await inWorkspace('api', busyWorkspace, {
        text: `explain (analyze, buffers, settings, format json) ${statement}`,
        values: [busyWorkspace],
        prepare: (client) => client.query("set local statement_timeout = '2s'"),
      }),
    );
  }

  it('bounds reservation row work to the installed workspace, not other tenants', async () => {
    await inWorkspace('owner', quietWorkspace, {
      text: `insert into app.workspace_execution_entitlement_versions
      (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
      values($1,2,'active',1000,1000,'-infinity')`,
      values: [quietWorkspace],
    });
    await inWorkspace('owner', quietWorkspace, {
      text: 'update app.workspace_execution_entitlements set current_version=2 where workspace_id=$1',
      values: [quietWorkspace],
    });
    await addRuns(quietWorkspace, elsewhere, {
      status: 'queued',
      count: 900,
      age: '2 hours',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'queued',
      count: 1,
      age: '2 hours',
    });
    for (const workspace of [quietWorkspace, busyWorkspace]) {
      await inWorkspace('owner', workspace, {
        text: `with event as (
        insert into app.outbox_events(id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum)
        select gen_random_uuid(),$1,'advance-workflow-run','workflow-run',id,'{}'::jsonb,repeat('a',64)
           from app.workflow_runs where workspace_id=$1 and status='queued' returning id,aggregate_id
      ) insert into app.workflow_run_active_admissions(workspace_id,workflow_run_id,outbox_event_id)
        select $1,aggregate_id,id from event`,
        values: [workspace],
      });
    }
    const superuser = new Pool({
      connectionString: statisticsDatabase.databaseUrl(superuserUrl),
      max: 1,
    });
    try {
      await superuser.query(
        'vacuum (analyze) app.workflow_run_active_admissions',
      );
    } finally {
      await superuser.end();
    }
    // Explain the scalar's SELECT as its owning role: PL/pgSQL statements are
    // otherwise opaque to outer EXPLAIN. This is the exact indexed predicate.
    const plan = explainDocument(
      await inWorkspace('owner', busyWorkspace, {
        text: 'explain (analyze,buffers,settings,format json) select count(*)::integer from app.workflow_run_active_admissions where workspace_id=$1',
        values: [busyWorkspace],
        prepare: (client) => client.query("set local statement_timeout='2s'"),
      }),
    );
    expect(plan.Settings?.enable_seqscan).not.toBe('off');
    expect(explainWork(plan.Plan).nodeTypes).not.toContain('Seq Scan');
    expect(indexScans(plan.Plan)).toMatchObject([
      {
        index: 'workflow_run_active_admissions_workspace_idx',
        nodeType: 'Index Only Scan',
        rows: 1,
        heapFetches: 0,
      },
    ]);
    expect(explainWork(plan.Plan).rejectedRowInstances).toBe(0);
    expect(explainWork(plan.Plan).summedNodeRowWork).toBeLessThanOrEqual(3);
    expect(
      (await runs.usageCapacity({ workspaceId: busyWorkspace })).execution,
    ).toMatchObject({
      queuedRuns: 1,
      reservedActiveSlots: 1,
      activeCapacityConsumed: 1,
    });
  }, 30_000);

  it('requires snapshot readiness before vacuuming the plan fixture', async () => {
    const reader = new Pool({
      connectionString: statisticsDatabase.databaseUrl(superuserUrl),
      max: 1,
      // Released transaction clients used to expire during a slow seed.
      idleTimeoutMillis: 100,
    });
    const vacuum = new Pool({
      connectionString: statisticsDatabase.databaseUrl(superuserUrl),
      max: 1,
    });
    const client = await reader.connect();
    try {
      await client.query('begin isolation level repeatable read');
      expect(
        (
          await client.query<{ count: number }>(
            'select count(*)::integer as count from app.workflow_runs',
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      await seedHistory();
      expect(
        (
          await client.query<{ count: number }>(
            'select count(*)::integer as count from app.workflow_runs',
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      // Reproduce the old setup: VACUUM succeeds, but cannot establish the
      // all-visible precondition while the pre-insert snapshot is held.
      await vacuum.query('vacuum (analyze) app.workflow_runs');
      const visibility = await vacuum.query<{ relallvisible: number }>(
        `select relallvisible from pg_class
         where oid = 'app.workflow_runs'::regclass`,
      );
      expect(visibility.rows[0]?.relallvisible).toBe(0);
      await expect(vacuumStatisticsFixture(50)).rejects.toThrow(
        'Statistics fixture still has active snapshots',
      );
      await client.query('rollback');
      await vacuumStatisticsFixture();
      const plan = await explainAsApi(
        `select workflow_id, status, count(*) from app.workflow_runs
         where workspace_id = $1
           and created_at >= transaction_timestamp() - make_interval(hours => 1)
           and created_at < transaction_timestamp()
         group by workflow_id, status`,
      );
      expect(indexScans(plan.Plan)).toMatchObject([
        {
          index: 'workflow_runs_workspace_created_statistics_idx',
          nodeType: 'Index Only Scan',
          rows: 96,
          heapFetches: 0,
        },
      ]);
      expect(explainWork(plan.Plan).rootSharedBufferTouches).toBeLessThan(40);
    } finally {
      try {
        await client.query('rollback');
      } finally {
        client.release();
        await Promise.all([reader.end(), vacuum.end()]);
      }
    }
  }, 30_000);

  it('reads only the window through index-only scans', async () => {
    await seedHistory();
    await vacuumStatisticsFixture();
    const inWindow = await inWorkspace<{ count: number }>(
      'owner',
      busyWorkspace,
      {
        text: `select count(*)::integer as count from app.workflow_runs
       where workspace_id = $1 and created_at >= now() - interval '1 hour'`,
        values: [busyWorkspace],
      },
    );
    const windowRows = inWindow.rows[0]?.count ?? 0;
    expect(windowRows).toBeGreaterThan(0);
    expect(windowRows).toBeLessThan(200);

    const window = `created_at >= transaction_timestamp() - make_interval(hours => 1)
      and created_at < transaction_timestamp()`;
    const plans = {
      current: await explainAsApi(
        `select count(*) filter (where status = 'queued') from app.workflow_runs
         where workspace_id = $1 and status in ('queued', 'running', 'waiting')`,
      ),
      window: await explainAsApi(
        `select status, count(*) from app.workflow_runs
         where workspace_id = $1 and ${window} group by status`,
      ),
      workflows: await explainAsApi(
        `select workflow_id, status, count(*) from app.workflow_runs
         where workspace_id = $1 and ${window} group by workflow_id, status`,
      ),
    };

    for (const [name, plan] of Object.entries(plans)) {
      expect(plan.Settings?.enable_seqscan).not.toBe('off');
      expect(explainWork(plan.Plan).nodeTypes).not.toContain('Seq Scan');
      for (const scan of indexScans(plan.Plan))
        expect(scan.nodeType, `${name}: ${JSON.stringify(plan)}`).toBe(
          'Index Only Scan',
        );
    }
    expect(indexScans(plans.current.Plan).map(({ index }) => index)).toEqual([
      'workflow_runs_workspace_status_created_idx',
    ]);
    for (const plan of [plans.window, plans.workflows]) {
      const [scan] = indexScans(plan.Plan);
      expect(scan).toMatchObject({
        index: 'workflow_runs_workspace_created_statistics_idx',
        rows: windowRows,
        heapFetches: 0,
      });
      // Budget: the scan emits the window's rows and the aggregate emits one
      // row per group; nothing outside the window is read or filtered out.
      const work = explainWork(plan.Plan);
      expect(work.rejectedRowInstances).toBe(0);
      expect(work.summedNodeRowWork).toBeLessThanOrEqual(windowRows * 2 + 100);
      expect(work.rootSharedBufferTouches).toBeLessThan(40);
    }
  }, 30_000);
});
registerCountsLogicalTriggerSkipsSeparately();
