import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../../src/config.js';
import { createWorkflowRunDatabase } from '../../src/runs/runs.repository.js';
import { migrateDatabase } from '../../src/migrations.js';
import {
  checkDatabaseReadiness,
  EXPECTED_MIGRATION_HEAD,
} from '../../src/platform/readiness.js';
import { WorkspaceAccessDeniedError } from '../../src/tenant-access/errors.js';
import { createDisposableDatabaseFixture } from '../support/postgres/disposable-database.js';
import {
  explainDocument,
  explainWork,
  indexScans,
  type ExplainDocument,
} from '../support/postgres/query-plan.js';

// ADR 044: exact run statistics from one bounded, workspace-scoped snapshot,
// with the index plans that keep the read inside its cost budget.

const superuserUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const statisticsDatabaseName = `pertexo_test_run_statistics_${randomUUID().slice(0, 8)}`;
const statisticsDatabase = createDisposableDatabaseFixture({
  databaseName: statisticsDatabaseName,
  ownerRole: 'pertexo_owner',
  connectRoles: ['pertexo_migration', 'pertexo_app'],
  adminUrl: superuserUrl,
});
const ownerUrl = statisticsDatabase.databaseUrl(
  process.env.DATABASE_MIGRATION_URL ??
    'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo',
);
const runtimeUrl = statisticsDatabase.databaseUrl(
  process.env.DATABASE_URL ??
    'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo',
);
const ownerPool = new Pool({ connectionString: ownerUrl, max: 1 });
const runtimePool = new Pool({ connectionString: runtimeUrl, max: 1 });
const runs = createWorkflowRunDatabase(
  parseDatabaseConfig({ connectionString: runtimeUrl, max: 2 }),
);

const person = randomUUID();
const busyWorkspace = randomUUID();
const quietWorkspace = randomUUID();
const intake = randomUUID();
const sync = randomUUID();
const elsewhere = randomUUID();

/** Runs a statement in one workspace's context, as the owner or API role. */
async function inWorkspace<Row extends Record<string, unknown>>(
  role: 'owner' | 'api',
  workspace: string,
  {
    text,
    values = [],
    prepare = () => Promise.resolve(),
  }: Readonly<{
    text: string;
    values?: readonly unknown[] | undefined;
    prepare?: ((client: PoolClient) => Promise<unknown>) | undefined;
  }>,
) {
  const client = await (role === 'owner' ? ownerPool : runtimePool).connect();
  try {
    await client.query('begin');
    if (role === 'owner') await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspace,
    ]);
    await prepare(client);
    const result = await client.query<Row>(text, [...values]);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Adds published workflows with their versions to one workspace. */
async function addWorkflows(
  workspace: string,
  workflows: readonly (readonly [id: string, name: string])[],
) {
  await inWorkspace('owner', workspace, {
    text: `with created as (
       insert into app.workflows
         (id, workspace_id, name, lifecycle_status, activation_status, created_by)
       select id, $1, name, 'active', 'inactive', $2
       from unnest($3::uuid[], $4::text[]) as named(id, name)
       returning id
     )
     insert into app.workflow_versions
       (id, workspace_id, workflow_id, version_number, graph_json, checksum, executable_json,
        published_by)
     select gen_random_uuid(), $1, created.id, 1,
            '{"nodes":[],"edges":[],"settings":{}}'::jsonb,
            'wf:sha256:' || repeat('e', 64),
            '{}'::jsonb, $2
      from created`,
    values: [
      workspace,
      person,
      workflows.map(([id]) => id),
      workflows.map(([, name]) => name),
    ],
  });
}

/** Inserts `count` runs as the API role, created a fixed time before now. */
async function addRuns(
  workspace: string,
  workflow: string,
  {
    status,
    count,
    age,
  }: Readonly<{ status: string; count: number; age: string }>,
) {
  await inWorkspace('api', workspace, {
    text: `insert into app.workflow_runs
       (id, workspace_id, workflow_id, workflow_version_id, trigger_type,
        status, created_at, updated_at)
     select gen_random_uuid(), $1, $2, version.id, 'api', $3,
            now() - $5::interval, now() - $5::interval
     from app.workflow_versions version
     cross join generate_series(1, $4::integer)
     where version.workspace_id = $1 and version.workflow_id = $2`,
    values: [workspace, workflow, status, count, age],
  });
}

async function seedWorkspaces() {
  await inWorkspace('owner', busyWorkspace, {
    text: `insert into app.users (id, email, display_name, status)
     values ($1, $2, 'Statistics reader', 'active')`,
    values: [person, `statistics-${person}@example.test`],
  });
  await inWorkspace('owner', busyWorkspace, {
    text: `insert into app.workspaces (id, name, slug, status, created_by)
     select id, 'Statistics ' || ordinal, 'statistics-' || id, 'active', $3
     from unnest(array[$1::uuid, $2::uuid]) with ordinality as listed(id, ordinal)`,
    values: [busyWorkspace, quietWorkspace, person],
  });
  for (const workspace of [busyWorkspace, quietWorkspace])
    await inWorkspace('owner', workspace, {
      text: "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active')",
      values: [workspace, person],
    });
  await addWorkflows(busyWorkspace, [
    [intake, 'Invoice intake'],
    [sync, 'Nightly sync'],
  ]);
  await addWorkflows(quietWorkspace, [[elsewhere, 'Elsewhere']]);
}

beforeAll(beforeAllFixture1);

beforeEach(beforeEachFixture2);

afterAll(afterAllFixture3);

describe('ADR 057 current capacity authority', () => {
  registerScalarReadInheritsBoundedStatement();

  registerChargesPendingAvailableDeletingArtifacts();
});

const zero = {
  queued: 0,
  running: 0,
  waiting: 0,
  succeeded: 0,
  failed: 0,
  canceled: 0,
  timed_out: 0,
  outcome_unknown: 0,
};

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

function registerScalarReadInheritsBoundedStatement(): void {
  it('the scalar read inherits the bounded statement timeout', async () => {
    const blocker = await ownerPool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('set local role pertexo_owner');
      await blocker.query(
        'lock table app.workflow_run_active_admissions in access exclusive mode',
      );
      await expect(
        runs.usageCapacity({ workspaceId: busyWorkspace }),
      ).rejects.toMatchObject({ cause: { code: '57014' } });
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
  });

  it.each(['suspended', 'pending_deletion'])(
    'does not return a snapshot after workspace becomes %s',
    async (status) => {
      await inWorkspace('owner', busyWorkspace, {
        text: `update app.workspaces set status=$2::varchar,
      deletion_requested_at=case when $2='pending_deletion' then now() else null end,
      deletion_requested_by=case when $2='pending_deletion' then $3::uuid else null end,
      deletion_reason=case when $2='pending_deletion' then 'Capacity test' else null end,
      purge_after=case when $2='pending_deletion' then now()+interval '30 days' else null end
      where id=$1`,
        values: [busyWorkspace, status, person],
      });
      await expect(
        runs.usageCapacity({ workspaceId: busyWorkspace }),
      ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    },
  );

  it('does not return lazy defaults for a missing workspace', async () => {
    await expect(
      runs.usageCapacity({ workspaceId: randomUUID() }),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  });

  it('reports provisioned execution and lazy artifact defaults', async () => {
    const result = await runs.usageCapacity({ workspaceId: busyWorkspace });
    expect(result.execution).toEqual({
      activeRuns: 0,
      reservedActiveSlots: 0,
      activeCapacityConsumed: 0,
      queuedRuns: 0,
      policy: {
        state: 'active',
        version: 1,
        activeRunLimit: 5,
        queuedRunLimit: 100,
      },
    });
    expect(result.artifacts).toEqual({
      chargedBytes: '0',
      byteLimit: '1073741824',
      chargedCount: 0,
      artifactCountLimit: 1000,
      source: 'default',
    });
    expect(result.asOf).toMatch(/\.\d{6}Z$/u);
    await expect(checkDatabaseReadiness(runtimePool)).resolves.toMatchObject({
      migrationHead: EXPECTED_MIGRATION_HEAD,
    });
  });

  it('counts active reservations without double counting queued runs or other tenants', async () => {
    await addRuns(busyWorkspace, intake, {
      status: 'running',
      count: 1,
      age: '2 hours',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'waiting',
      count: 1,
      age: '2 hours',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'queued',
      count: 2,
      age: '2 hours',
    });
    await addRuns(quietWorkspace, elsewhere, {
      status: 'running',
      count: 1,
      age: '2 hours',
    });
    await addRuns(quietWorkspace, elsewhere, {
      status: 'queued',
      count: 1,
      age: '2 hours',
    });
    for (const workspace of [busyWorkspace, quietWorkspace]) {
      await inWorkspace('owner', workspace, {
        text: `with selected as (
      select id from app.workflow_runs where workspace_id=$1 and status='queued' limit 1
    ), event as (
      insert into app.outbox_events(id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum)
      select gen_random_uuid(),$1,'advance-workflow-run','workflow-run',id,'{}'::jsonb,repeat('a',64)  from selected returning id,aggregate_id
    ) insert into app.workflow_run_active_admissions(workspace_id,workflow_run_id,outbox_event_id)
      select $1,aggregate_id,id from event`,
        values: [workspace],
      });
    }
    const result = await runs.usageCapacity({ workspaceId: busyWorkspace });
    expect(result.execution).toMatchObject({
      activeRuns: 2,
      reservedActiveSlots: 1,
      activeCapacityConsumed: 3,
      queuedRuns: 2,
    });
    const counter = await inWorkspace('api', busyWorkspace, {
      text: 'select active_runs from app.workspace_execution_admission_counters where workspace_id=$1',
      values: [busyWorkspace],
    });
    expect(counter.rows[0]?.active_runs).toBe(2);
    const reservations = await inWorkspace('api', busyWorkspace, {
      text: 'select workspace_id from app.workflow_run_active_admissions',
    });
    expect(reservations.rows).toEqual([{ workspace_id: busyWorkspace }]);
    const otherWorkspace = await inWorkspace('api', busyWorkspace, {
      text: 'select * from app.workflow_run_active_admissions where workspace_id=$1',
      values: [quietWorkspace],
    });
    expect(otherWorkspace.rows).toEqual([]);
    const withoutContext = await runtimePool.query(
      'select * from app.workflow_run_active_admissions',
    );
    expect(withoutContext.rows).toEqual([]);
    await expect(
      inWorkspace('api', busyWorkspace, {
        text: 'delete from app.workflow_run_active_admissions where workspace_id=$1',
        values: [busyWorkspace],
      }),
    ).rejects.toThrow(/permission denied/u);
  });

  it.each([
    ['suspended', 'suspended', '-infinity', null],
    ['not_yet_effective', 'active', 'infinity', null],
    ['expired', 'active', '-infinity', '2000-01-01'],
  ])(
    'reports configured %s policy without inventing effective limits',
    async (state, status, effectiveAt, expiresAt) => {
      await inWorkspace('owner', busyWorkspace, {
        text: `insert into app.workspace_execution_entitlement_versions
      (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at,expires_at)
      values($1,2,$2,7,120,$3::timestamptz,$4::timestamptz)`,
        values: [busyWorkspace, status, effectiveAt, expiresAt],
      });
      await inWorkspace('owner', busyWorkspace, {
        text: 'update app.workspace_execution_entitlements set current_version=2 where workspace_id=$1',
        values: [busyWorkspace],
      });
      expect(
        (await runs.usageCapacity({ workspaceId: busyWorkspace })).execution
          .policy,
      ).toEqual({ state, version: 2, activeRunLimit: 7, queuedRunLimit: 120 });
    },
  );

  it('reports missing counter authority unavailable, then missing pointer with nullable limits', async () => {
    await inWorkspace('owner', busyWorkspace, {
      text: 'delete from app.workspace_execution_admission_counters where workspace_id=$1',
      values: [busyWorkspace],
    });
    expect(
      (await runs.usageCapacity({ workspaceId: busyWorkspace })).execution
        .policy,
    ).toEqual({
      state: 'unavailable',
      version: 1,
      activeRunLimit: 5,
      queuedRunLimit: 100,
    });
    await inWorkspace('owner', busyWorkspace, {
      text: 'delete from app.workspace_execution_entitlements where workspace_id=$1',
      values: [busyWorkspace],
    });
    expect(
      (await runs.usageCapacity({ workspaceId: busyWorkspace })).execution
        .policy,
    ).toEqual({
      state: 'unavailable',
      version: null,
      activeRunLimit: null,
      queuedRunLimit: null,
    });
  });
}

function registerChargesPendingAvailableDeletingArtifacts(): void {
  it('charges pending, available and deleting artifacts until completed deletion; zero limits remain zero', async () => {
    const artifact = randomUUID();
    await inWorkspace('api', busyWorkspace, {
      text: `insert into app.artifacts(id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,status,expires_at)
      values($2::uuid,$1::uuid,'user-upload','workspaces/'||$1::uuid::text||'/artifacts/'||$2::uuid::text,'text/plain',123,repeat('a',64),'pending',now()+interval '1 hour')`,
      values: [busyWorkspace, artifact],
    });
    for (const state of ['pending', 'available', 'deleting']) {
      if (state !== 'pending')
        await inWorkspace('api', busyWorkspace, {
          text: 'update app.artifacts set status=$3,finalized_at=coalesce(finalized_at,now()) where workspace_id=$1 and id=$2',
          values: [busyWorkspace, artifact, state],
        });
      expect(
        (await runs.usageCapacity({ workspaceId: busyWorkspace })).artifacts,
      ).toMatchObject({
        chargedBytes: '123',
        chargedCount: 1,
        source: 'stored',
      });
    }
    await inWorkspace('owner', busyWorkspace, {
      text: 'update app.workspace_artifact_capacity set byte_limit=0,artifact_count_limit=0 where workspace_id=$1',
      values: [busyWorkspace],
    });
    expect(
      (await runs.usageCapacity({ workspaceId: busyWorkspace })).artifacts,
    ).toEqual({
      chargedBytes: '123',
      byteLimit: '0',
      chargedCount: 1,
      artifactCountLimit: 0,
      source: 'stored',
    });
    await inWorkspace('api', busyWorkspace, {
      text: "update app.artifacts set status='deleted',deleted_at=now() where workspace_id=$1 and id=$2",
      values: [busyWorkspace, artifact],
    });
    expect(
      (await runs.usageCapacity({ workspaceId: busyWorkspace })).artifacts
        .chargedBytes,
    ).toBe('0');
    await inWorkspace('owner', busyWorkspace, {
      text: 'update app.workspace_artifact_capacity set byte_limit=9223372036854775807 where workspace_id=$1',
      values: [busyWorkspace],
    });
    expect(
      (await runs.usageCapacity({ workspaceId: busyWorkspace })).artifacts
        .byteLimit,
    ).toBe('9223372036854775807');
  });
}

function registerExcludesTestsListsAllHistory(): void {
  it('excludes tests from lists and all history statistics while counting their capacity', async () => {
    await addRuns(busyWorkspace, intake, {
      status: 'queued',
      count: 1,
      age: '1 hour',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'succeeded',
      count: 1,
      age: '1 hour',
    });
    for (const status of [
      'queued',
      'running',
      'waiting',
      'succeeded',
      'failed',
      'canceled',
      'timed_out',
      'outcome_unknown',
    ])
      await addRuns(busyWorkspace, sync, {
        status: status,
        count: 1,
        age: '5 minutes',
      });
    await inWorkspace('owner', busyWorkspace, {
      text: `update app.workflow_runs set trigger_type='test' where workspace_id=$1 and workflow_id=$2`,
      values: [busyWorkspace, sync],
    });

    const page = await runs.list({
      actorId: person,
      workspaceId: busyWorkspace,
      limit: 100,
      includeWorkflowName: true,
    });
    expect(page.items).toHaveLength(2);
    expect(
      page.items.every(
        (run) => run.workflowId === intake && run.triggerType === 'api',
      ),
    ).toBe(true);
    expect(
      (
        await runs.list({
          actorId: person,
          workspaceId: busyWorkspace,
          workflowId: sync,
          limit: 100,
        })
      ).items,
    ).toEqual([]);
    const firstPage = await runs.list({
      actorId: person,
      workspaceId: busyWorkspace,
      limit: 1,
    });
    expect(firstPage.items[0]?.workflowId).toBe(intake);
    expect(firstPage.nextCursor).toBeDefined();
    const statistics = await runs.statistics({
      actorId: person,
      workspaceId: busyWorkspace,
      window: '24h',
      includeWorkflows: true,
      includeWorkflowName: true,
    });
    expect(statistics.current).toEqual({ queued: 1, running: 0, waiting: 0 });
    expect(statistics.window.total).toBe(2);
    expect(statistics.window.byStatus).toEqual({
      queued: 1,
      running: 0,
      waiting: 0,
      succeeded: 1,
      failed: 0,
      canceled: 0,
      timed_out: 0,
      outcome_unknown: 0,
    });
    expect(statistics.workflows?.items).toHaveLength(1);
    expect(statistics.workflows?.items[0]).toMatchObject({
      workflowId: intake,
      total: 2,
      byStatus: statistics.window.byStatus,
    });
    expect(
      (await runs.usageCapacity({ workspaceId: busyWorkspace })).execution,
    ).toMatchObject({ activeRuns: 2, queuedRuns: 2 });
  });

  it('counts current, windowed and per-workflow runs exactly in one snapshot', async () => {
    await addRuns(busyWorkspace, intake, {
      status: 'succeeded',
      count: 3,
      age: '10 minutes',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'failed',
      count: 1,
      age: '10 minutes',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'failed',
      count: 2,
      age: '3 hours',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'timed_out',
      count: 1,
      age: '3 hours',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'succeeded',
      count: 2,
      age: '12 hours',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'outcome_unknown',
      count: 1,
      age: '12 hours',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'canceled',
      count: 1,
      age: '12 hours',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'succeeded',
      count: 4,
      age: '3 days',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'succeeded',
      count: 5,
      age: '10 days',
    });
    await addRuns(busyWorkspace, sync, {
      status: 'running',
      count: 2,
      age: '20 minutes',
    });
    await addRuns(busyWorkspace, sync, {
      status: 'queued',
      count: 3,
      age: '20 minutes',
    });
    await addRuns(busyWorkspace, sync, {
      status: 'waiting',
      count: 1,
      age: '2 days',
    });
    await addRuns(quietWorkspace, elsewhere, {
      status: 'succeeded',
      count: 7,
      age: '10 minutes',
    });
    await addRuns(quietWorkspace, elsewhere, {
      status: 'running',
      count: 1,
      age: '10 minutes',
    });

    const hour = await runs.statistics({
      actorId: person,
      workspaceId: busyWorkspace,
      window: '1h',
    });
    expect(hour.current).toEqual({ queued: 3, running: 2, waiting: 1 });
    expect(hour.window).toMatchObject({
      duration: '1h',
      createdAtBefore: hour.asOf,
      total: 9,
      byStatus: { ...zero, succeeded: 3, failed: 1, running: 2, queued: 3 },
    });
    expect(hour).not.toHaveProperty('workflows');
    expect(hour.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);
    expect(
      Date.parse(hour.window.createdAtBefore) -
        Date.parse(hour.window.createdAtFrom),
    ).toBe(3_600_000);
    expect(hour.window.createdAtFrom.slice(-8)).toBe(hour.asOf.slice(-8));

    await expect(
      runs.statistics({
        actorId: person,
        workspaceId: busyWorkspace,
        window: '6h',
      }),
    ).resolves.toMatchObject({
      window: {
        total: 12,
        byStatus: {
          ...zero,
          queued: 3,
          running: 2,
          succeeded: 3,
          failed: 3,
          timed_out: 1,
        },
      },
    });
    await expect(
      runs.statistics({
        actorId: person,
        workspaceId: busyWorkspace,
        window: '7d',
      }),
    ).resolves.toMatchObject({
      current: { queued: 3, running: 2, waiting: 1 },
      window: {
        total: 21,
        byStatus: {
          queued: 3,
          running: 2,
          waiting: 1,
          succeeded: 9,
          failed: 3,
          canceled: 1,
          timed_out: 1,
          outcome_unknown: 1,
        },
      },
    });

    const day = await runs.statistics({
      actorId: person,
      workspaceId: busyWorkspace,
      window: '24h',
      includeWorkflows: true,
      includeWorkflowName: true,
    });
    expect(day.window.total).toBe(16);
    expect(day.workflows).toEqual({
      truncated: false,
      items: [
        {
          workflowId: intake,
          workflowName: 'Invoice intake',
          total: 11,
          byStatus: {
            ...zero,
            succeeded: 5,
            failed: 3,
            timed_out: 1,
            outcome_unknown: 1,
            canceled: 1,
          },
        },
        {
          workflowId: sync,
          workflowName: 'Nightly sync',
          total: 5,
          byStatus: { ...zero, running: 2, queued: 3 },
        },
      ],
    });
    const unnamed = await runs.statistics({
      actorId: person,
      workspaceId: busyWorkspace,
      window: '24h',
      includeWorkflows: true,
    });
    expect(
      unnamed.workflows?.items.map(({ workflowName }) => workflowName),
    ).toEqual([null, null]);

    await expect(
      runs.statistics({
        actorId: person,
        workspaceId: quietWorkspace,
        window: '24h',
        includeWorkflows: true,
        includeWorkflowName: true,
      }),
    ).resolves.toMatchObject({
      current: { queued: 0, running: 1, waiting: 0 },
      window: { total: 8, byStatus: { ...zero, succeeded: 7, running: 1 } },
      workflows: {
        truncated: false,
        items: [{ workflowId: elsewhere, workflowName: 'Elsewhere' }],
      },
    });
  });
}

function registerReturnsZerosIdleWorkspaceRejects(): void {
  it('returns zeros for an idle workspace and rejects unsupported windows', async () => {
    await expect(
      runs.statistics({
        actorId: person,
        workspaceId: busyWorkspace,
        window: '24h',
        includeWorkflows: true,
      }),
    ).resolves.toMatchObject({
      current: { queued: 0, running: 0, waiting: 0 },
      window: { total: 0, byStatus: zero },
      workflows: { items: [], truncated: false },
    });
    await expect(
      runs.statistics({
        actorId: person,
        workspaceId: busyWorkspace,
        window: '30d' as '7d',
      }),
    ).rejects.toThrow();
    await expect(
      runs.statistics({
        actorId: person,
        workspaceId: 'not-a-workspace',
        window: '1h',
      }),
    ).rejects.toThrow();
  });

  it('keeps the 50 busiest workflows, then the lowest identifiers, and says when it cut', async () => {
    const many = Array.from(
      { length: 52 },
      (_, index) =>
        [
          `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          `Workflow ${String(index)}`,
        ] as const,
    );
    await addWorkflows(busyWorkspace, many);
    for (const [id] of many)
      await addRuns(busyWorkspace, id, {
        status: 'succeeded',
        count: 1,
        age: '5 minutes',
      });
    const busiest = many[51]?.[0] ?? '';
    await addRuns(busyWorkspace, busiest, {
      status: 'failed',
      count: 2,
      age: '5 minutes',
    });

    const statistics = await runs.statistics({
      actorId: person,
      workspaceId: busyWorkspace,
      window: '1h',
      includeWorkflows: true,
    });

    expect(statistics.window.total).toBe(54);
    expect(statistics.workflows?.truncated).toBe(true);
    expect(statistics.workflows?.items).toHaveLength(50);
    expect(statistics.workflows?.items[0]).toMatchObject({
      workflowId: busiest,
      total: 3,
      byStatus: { ...zero, succeeded: 1, failed: 2 },
    });
    expect(
      statistics.workflows?.items.slice(1).map(({ workflowId }) => workflowId),
    ).toEqual(many.slice(0, 49).map(([id]) => id));
  });
}

async function beforeAllFixture1() {
  await statisticsDatabase.create();
  try {
    await migrateDatabase({
      connectionString: ownerUrl,
      ownerRole: 'pertexo_owner',
      appRole: 'pertexo_app',
      maintenanceRole: 'pertexo_maintenance',
    });
  } catch (error: unknown) {
    await statisticsDatabase.drop().catch(() => undefined);
    throw error;
  }
}

async function beforeEachFixture2() {
  await inWorkspace('owner', busyWorkspace, {
    text: `truncate table app.workflow_runs, app.workflow_versions, app.workflows,
       app.workspace_memberships, app.workspaces, app.users cascade`,
  });
  await seedWorkspaces();
}

async function afterAllFixture3() {
  const closed = await Promise.allSettled([
    runs.close(),
    ownerPool.end(),
    runtimePool.end(),
  ]);
  const failures: unknown[] = closed.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
  );
  await statisticsDatabase.drop().catch((error: unknown) => {
    failures.push(error);
  });
  if (failures.length > 0)
    throw new AggregateError(failures, 'Run statistics cleanup failed');
}

function registerCountsLogicalTriggerSkipsSeparately(): void {
  it('counts logical trigger skips separately from runs in the same bounded workspace window', async () => {
    const id = randomUUID();
    await inWorkspace('api', busyWorkspace, {
      text: `insert into app.usage_events(id,workspace_id,category,quantity,resource_type,resource_id,idempotency_key,metadata) values($1,$2,'trigger.skipped',1,'workflow',$3,$4,'{"triggerType":"webhook","reason":"concurrency_limit"}')`,
      values: [id, busyWorkspace, intake, `trigger-skip:${id}`],
    });
    const result = await runs.statistics({
      actorId: person,
      workspaceId: busyWorkspace,
      window: '24h',
    });
    expect(result.window.skippedTriggerEvents).toBe(1);
    expect(result.window.total).toBe(
      Object.values(result.window.byStatus).reduce(
        (sum, count) => sum + count,
        0,
      ),
    );
    expect(
      (
        await runs.statistics({
          actorId: person,
          workspaceId: quietWorkspace,
          window: '24h',
        })
      ).window.skippedTriggerEvents,
    ).toBe(0);
  });
}
