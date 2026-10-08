import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createWorkflowRunDatabase } from '../src/execution/runs/workflow-run-api.js';
import { migrateDatabase } from '../src/migrations.js';
import { checkDatabaseReadiness } from '../src/platform/readiness.js';
import { WorkspaceAccessDeniedError } from '../src/tenant-access/identity-workspace-errors.js';
import { BASELINE_COMPATIBILITY_EXPECTATION } from './baseline-compatibility-fixture.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';
import {
  explainDocument,
  explainWork,
  indexScans,
  type ExplainDocument,
} from './support/query-plan.js';

// ADR 044: exact run statistics from one bounded, workspace-scoped snapshot,
// with the index plans that keep the read inside its cost budget.

const superuserUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const statisticsDatabaseName = `pertexo_test_run_statistics_${randomUUID().slice(0, 8)}`;
const statisticsDatabase = createDisposableDatabaseFixture({
  databaseName: statisticsDatabaseName,
  ownerRole: 'pertexo_owner',
  connectRoles: ['pertexo_migration', 'pertexo_api'],
  adminUrl: superuserUrl,
});
const ownerUrl = statisticsDatabase.databaseUrl(
  process.env.DATABASE_MIGRATION_URL ??
    'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo',
);
const runtimeUrl = statisticsDatabase.databaseUrl(
  process.env.DATABASE_API_URL ??
    'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo',
);
const ownerPool = new Pool({ connectionString: ownerUrl, max: 1 });
const runtimePool = new Pool({ connectionString: runtimeUrl, max: 1 });
const runs = createWorkflowRunDatabase(
  parseDatabaseConfig({ connectionString: runtimeUrl, max: 2 }),
  BASELINE_COMPATIBILITY_EXPECTATION,
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
  text: string,
  values: readonly unknown[] = [],
  prepare: (client: PoolClient) => Promise<unknown> = () => Promise.resolve(),
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
  await inWorkspace(
    'owner',
    workspace,
    `with created as (
       insert into app.workflows
         (id, workspace_id, name, lifecycle_status, activation_status, created_by)
       select id, $1, name, 'active', 'inactive', $2
       from unnest($3::uuid[], $4::text[]) as named(id, name)
       returning id
     )
     insert into app.workflow_versions
       (id, workspace_id, workflow_id, version_number, schema_version,
        graph_json, checksum, executable_schema_version, executable_json,
        compatibility_release_epoch, published_by)
     select gen_random_uuid(), $1, created.id, 1, 1,
            '{"schemaVersion":1,"nodes":[],"edges":[],"settings":{}}'::jsonb,
            'wf:v2:sha256:' || repeat('e', 64), 2,
            '{"schemaVersion":2}'::jsonb, 1, $2
     from created`,
    [
      workspace,
      person,
      workflows.map(([id]) => id),
      workflows.map(([, name]) => name),
    ],
  );
}

/** Inserts `count` runs as the API role, created a fixed time before now. */
async function addRuns(
  workspace: string,
  workflow: string,
  status: string,
  count: number,
  age: string,
) {
  await inWorkspace(
    'api',
    workspace,
    `insert into app.workflow_runs
       (id, workspace_id, workflow_id, workflow_version_id, trigger_type,
        status, created_at, updated_at)
     select gen_random_uuid(), $1, $2, version.id, 'api', $3,
            now() - $5::interval, now() - $5::interval
     from app.workflow_versions version
     cross join generate_series(1, $4::integer)
     where version.workspace_id = $1 and version.workflow_id = $2`,
    [workspace, workflow, status, count, age],
  );
}

async function seedWorkspaces() {
  await inWorkspace(
    'owner',
    busyWorkspace,
    `insert into app.users (id, email, display_name, status)
     values ($1, $2, 'Statistics reader', 'active')`,
    [person, `statistics-${person}@example.test`],
  );
  await inWorkspace(
    'owner',
    busyWorkspace,
    `insert into app.workspaces (id, name, slug, status, created_by)
     select id, 'Statistics ' || ordinal, 'statistics-' || id, 'active', $3
     from unnest(array[$1::uuid, $2::uuid]) with ordinality as listed(id, ordinal)`,
    [busyWorkspace, quietWorkspace, person],
  );
  await addWorkflows(busyWorkspace, [
    [intake, 'Invoice intake'],
    [sync, 'Nightly sync'],
  ]);
  await addWorkflows(quietWorkspace, [[elsewhere, 'Elsewhere']]);
}

beforeAll(async () => {
  await statisticsDatabase.create();
  try {
    await migrateDatabase({
      connectionString: ownerUrl,
      ownerRole: 'pertexo_owner',
      apiRuntimeRole: 'pertexo_api',
      workerRuntimeRole: 'pertexo_worker',
      dispatcherRole: 'pertexo_dispatcher',
      maintenanceRole: 'pertexo_maintenance',
      lifecycleCommandRole: 'pertexo_lifecycle_command',
      operatorRole: 'pertexo_operator',
    });
  } catch (error: unknown) {
    await statisticsDatabase.drop().catch(() => undefined);
    throw error;
  }
});

beforeEach(async () => {
  await inWorkspace(
    'owner',
    busyWorkspace,
    `truncate table app.workflow_runs, app.workflow_versions, app.workflows,
       app.workspace_memberships, app.workspaces, app.users cascade`,
  );
  await seedWorkspaces();
});

afterAll(async () => {
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
});

describe('ADR 057 current capacity authority', () => {
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
      await inWorkspace(
        'owner',
        busyWorkspace,
        `update app.workspaces set status=$2::varchar,
      deletion_requested_at=case when $2='pending_deletion' then now() else null end,
      deletion_requested_by=case when $2='pending_deletion' then $3::uuid else null end,
      deletion_reason=case when $2='pending_deletion' then 'Capacity test' else null end,
      purge_after=case when $2='pending_deletion' then now()+interval '30 days' else null end
      where id=$1`,
        [busyWorkspace, status, person],
      );
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
      migrationHead: '0136_remove_release_machinery.sql',
    });
    const grants = await runtimePool.query(`select
      has_function_privilege('pertexo_api','app.workspace_reserved_active_slot_count(uuid)','EXECUTE') as api,
      has_function_privilege('pertexo_worker','app.workspace_reserved_active_slot_count(uuid)','EXECUTE') as worker,
      has_function_privilege('pertexo_dispatcher','app.workspace_reserved_active_slot_count(uuid)','EXECUTE') as dispatcher,
      has_function_privilege('pertexo_operator','app.workspace_reserved_active_slot_count(uuid)','EXECUTE') as operator`);
    expect(grants.rows).toEqual([
      { api: true, worker: false, dispatcher: false, operator: false },
    ]);
  });

  it('counts active reservations without double counting queued runs or other tenants', async () => {
    await addRuns(busyWorkspace, intake, 'running', 1, '2 hours');
    await addRuns(busyWorkspace, intake, 'waiting', 1, '2 hours');
    await addRuns(busyWorkspace, intake, 'queued', 2, '2 hours');
    await addRuns(quietWorkspace, elsewhere, 'running', 1, '2 hours');
    await inWorkspace(
      'owner',
      busyWorkspace,
      `with selected as (
      select id from app.workflow_runs where workspace_id=$1 and status='queued' limit 1
    ), event as (
      insert into app.outbox_events(id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,payload,payload_checksum)
      select gen_random_uuid(),$1,'advance-workflow-run',1,'workflow-run',id,'{}'::jsonb,repeat('a',64) from selected returning id,aggregate_id
    ) insert into app.workflow_run_active_admissions(workspace_id,workflow_run_id,outbox_event_id)
      select $1,aggregate_id,id from event`,
      [busyWorkspace],
    );
    const result = await runs.usageCapacity({ workspaceId: busyWorkspace });
    expect(result.execution).toMatchObject({
      activeRuns: 2,
      reservedActiveSlots: 1,
      activeCapacityConsumed: 3,
      queuedRuns: 2,
    });
    const counter = await inWorkspace(
      'api',
      busyWorkspace,
      'select active_runs from app.workspace_execution_admission_counters where workspace_id=$1',
      [busyWorkspace],
    );
    expect(counter.rows[0]?.active_runs).toBe(2);
    await expect(
      inWorkspace(
        'api',
        busyWorkspace,
        'select * from app.workflow_run_active_admissions',
      ),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      inWorkspace(
        'api',
        busyWorkspace,
        'select app.workspace_reserved_active_slot_count($1)',
        [quietWorkspace],
      ),
    ).rejects.toThrow('workspace context mismatch');
    await expect(
      runtimePool.query('select app.workspace_reserved_active_slot_count($1)', [
        busyWorkspace,
      ]),
    ).rejects.toThrow('workspace context mismatch');
  });

  it.each([
    ['suspended', 'suspended', '-infinity', null],
    ['not_yet_effective', 'active', 'infinity', null],
    ['expired', 'active', '-infinity', '2000-01-01'],
  ])(
    'reports configured %s policy without inventing effective limits',
    async (state, status, effectiveAt, expiresAt) => {
      await inWorkspace(
        'owner',
        busyWorkspace,
        `insert into app.workspace_execution_entitlement_versions
      (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at,expires_at)
      values($1,2,$2,7,120,$3::timestamptz,$4::timestamptz)`,
        [busyWorkspace, status, effectiveAt, expiresAt],
      );
      await inWorkspace(
        'owner',
        busyWorkspace,
        'update app.workspace_execution_entitlements set current_version=2 where workspace_id=$1',
        [busyWorkspace],
      );
      expect(
        (await runs.usageCapacity({ workspaceId: busyWorkspace })).execution
          .policy,
      ).toEqual({ state, version: 2, activeRunLimit: 7, queuedRunLimit: 120 });
    },
  );

  it('reports missing counter authority unavailable, then missing pointer with nullable limits', async () => {
    await inWorkspace(
      'owner',
      busyWorkspace,
      'delete from app.workspace_execution_admission_counters where workspace_id=$1',
      [busyWorkspace],
    );
    expect(
      (await runs.usageCapacity({ workspaceId: busyWorkspace })).execution
        .policy,
    ).toEqual({
      state: 'unavailable',
      version: 1,
      activeRunLimit: 5,
      queuedRunLimit: 100,
    });
    await inWorkspace(
      'owner',
      busyWorkspace,
      'delete from app.workspace_execution_entitlements where workspace_id=$1',
      [busyWorkspace],
    );
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

  it('charges pending, available and deleting artifacts until completed deletion; zero limits remain zero', async () => {
    const artifact = randomUUID();
    await inWorkspace(
      'api',
      busyWorkspace,
      `insert into app.artifacts(id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,status,expires_at)
      values($2::uuid,$1::uuid,'user-upload','workspaces/'||$1::uuid::text||'/artifacts/'||$2::uuid::text,'text/plain',123,repeat('a',64),'pending',now()+interval '1 hour')`,
      [busyWorkspace, artifact],
    );
    for (const state of ['pending', 'available', 'deleting']) {
      if (state !== 'pending')
        await inWorkspace(
          'api',
          busyWorkspace,
          'update app.artifacts set status=$3,finalized_at=coalesce(finalized_at,now()) where workspace_id=$1 and id=$2',
          [busyWorkspace, artifact, state],
        );
      expect(
        (await runs.usageCapacity({ workspaceId: busyWorkspace })).artifacts,
      ).toMatchObject({
        chargedBytes: '123',
        chargedCount: 1,
        source: 'stored',
      });
    }
    await inWorkspace(
      'owner',
      busyWorkspace,
      'update app.workspace_artifact_capacity set byte_limit=0,artifact_count_limit=0 where workspace_id=$1',
      [busyWorkspace],
    );
    expect(
      (await runs.usageCapacity({ workspaceId: busyWorkspace })).artifacts,
    ).toEqual({
      chargedBytes: '123',
      byteLimit: '0',
      chargedCount: 1,
      artifactCountLimit: 0,
      source: 'stored',
    });
    await inWorkspace(
      'api',
      busyWorkspace,
      "update app.artifacts set status='deleted',deleted_at=now() where workspace_id=$1 and id=$2",
      [busyWorkspace, artifact],
    );
    expect(
      (await runs.usageCapacity({ workspaceId: busyWorkspace })).artifacts
        .chargedBytes,
    ).toBe('0');
    await inWorkspace(
      'owner',
      busyWorkspace,
      'update app.workspace_artifact_capacity set byte_limit=9223372036854775807 where workspace_id=$1',
      [busyWorkspace],
    );
    expect(
      (await runs.usageCapacity({ workspaceId: busyWorkspace })).artifacts
        .byteLimit,
    ).toBe('9223372036854775807');
  });
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
  it('counts current, windowed and per-workflow runs exactly in one snapshot', async () => {
    await addRuns(busyWorkspace, intake, 'succeeded', 3, '10 minutes');
    await addRuns(busyWorkspace, intake, 'failed', 1, '10 minutes');
    await addRuns(busyWorkspace, intake, 'failed', 2, '3 hours');
    await addRuns(busyWorkspace, intake, 'timed_out', 1, '3 hours');
    await addRuns(busyWorkspace, intake, 'succeeded', 2, '12 hours');
    await addRuns(busyWorkspace, intake, 'outcome_unknown', 1, '12 hours');
    await addRuns(busyWorkspace, intake, 'canceled', 1, '12 hours');
    await addRuns(busyWorkspace, intake, 'succeeded', 4, '3 days');
    await addRuns(busyWorkspace, intake, 'succeeded', 5, '10 days');
    await addRuns(busyWorkspace, sync, 'running', 2, '20 minutes');
    await addRuns(busyWorkspace, sync, 'queued', 3, '20 minutes');
    await addRuns(busyWorkspace, sync, 'waiting', 1, '2 days');
    await addRuns(quietWorkspace, elsewhere, 'succeeded', 7, '10 minutes');
    await addRuns(quietWorkspace, elsewhere, 'running', 1, '10 minutes');

    const hour = await runs.statistics({
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
      runs.statistics({ workspaceId: busyWorkspace, window: '6h' }),
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
      runs.statistics({ workspaceId: busyWorkspace, window: '7d' }),
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
      workspaceId: busyWorkspace,
      window: '24h',
      includeWorkflows: true,
    });
    expect(
      unnamed.workflows?.items.map(({ workflowName }) => workflowName),
    ).toEqual([null, null]);

    await expect(
      runs.statistics({
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

  it('returns zeros for an idle workspace and rejects unsupported windows', async () => {
    await expect(
      runs.statistics({
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
        workspaceId: busyWorkspace,
        window: '30d' as '7d',
      }),
    ).rejects.toThrow();
    await expect(
      runs.statistics({ workspaceId: 'not-a-workspace', window: '1h' }),
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
      await addRuns(busyWorkspace, id, 'succeeded', 1, '5 minutes');
    const busiest = many[51]?.[0] ?? '';
    await addRuns(busyWorkspace, busiest, 'failed', 2, '5 minutes');

    const statistics = await runs.statistics({
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
    await inWorkspace(
      'api',
      busyWorkspace,
      `insert into app.workflow_runs
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
      [busyWorkspace, workflows.map(([id]) => id)],
    );
    await addRuns(quietWorkspace, elsewhere, 'succeeded', 2_500, '30 minutes');
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
      await inWorkspace(
        'api',
        busyWorkspace,
        `explain (analyze, buffers, settings, format json) ${statement}`,
        [busyWorkspace],
        // The same local statement budget the read applies.
        (client) => client.query("set local statement_timeout = '2s'"),
      ),
    );
  }

  it('bounds reservation row work to the installed workspace, not other tenants', async () => {
    await inWorkspace(
      'owner',
      quietWorkspace,
      `insert into app.workspace_execution_entitlement_versions
      (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
      values($1,2,'active',1000,1000,'-infinity')`,
      [quietWorkspace],
    );
    await inWorkspace(
      'owner',
      quietWorkspace,
      'update app.workspace_execution_entitlements set current_version=2 where workspace_id=$1',
      [quietWorkspace],
    );
    await addRuns(quietWorkspace, elsewhere, 'queued', 900, '2 hours');
    await addRuns(busyWorkspace, intake, 'queued', 1, '2 hours');
    for (const workspace of [quietWorkspace, busyWorkspace]) {
      await inWorkspace(
        'owner',
        workspace,
        `with event as (
        insert into app.outbox_events(id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,payload,payload_checksum)
        select gen_random_uuid(),$1,'advance-workflow-run',1,'workflow-run',id,'{}'::jsonb,repeat('a',64)
          from app.workflow_runs where workspace_id=$1 and status='queued' returning id,aggregate_id
      ) insert into app.workflow_run_active_admissions(workspace_id,workflow_run_id,outbox_event_id)
        select $1,aggregate_id,id from event`,
        [workspace],
      );
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
      await inWorkspace(
        'owner',
        busyWorkspace,
        'explain (analyze,buffers,settings,format json) select count(*)::integer from app.workflow_run_active_admissions where workspace_id=$1',
        [busyWorkspace],
        (client) => client.query("set local statement_timeout='2s'"),
      ),
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
    });
    const vacuum = new Pool({
      connectionString: statisticsDatabase.databaseUrl(superuserUrl),
      max: 1,
    });
    try {
      await reader.query('begin isolation level repeatable read');
      await reader.query('select pg_current_snapshot()');
      await seedHistory();
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
      await reader.query('rollback');
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
        await reader.query('rollback');
      } finally {
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
      `select count(*)::integer as count from app.workflow_runs
       where workspace_id = $1 and created_at >= now() - interval '1 hour'`,
      [busyWorkspace],
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
