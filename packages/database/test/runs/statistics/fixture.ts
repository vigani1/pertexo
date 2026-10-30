import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';

import { parseDatabaseConfig } from '../../../src/config.js';
import { createWorkflowRunDatabase } from '../../../src/runs/runs.repository.js';
import { createWorkspaceDatabase } from '../../../src/testing.js';
import { migrateDatabase } from '../../../src/migrations.js';

import { createDisposableDatabaseFixture } from '../../support/postgres/disposable-database.js';

// ADR 044: exact run statistics from one bounded, workspace-scoped snapshot,
// with the index plans that keep the read inside its cost budget.
export const superuserUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';

const statisticsDatabaseName = `pertexo_test_run_statistics_${randomUUID().slice(0, 8)}`;

export const statisticsDatabase = createDisposableDatabaseFixture({
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

export const ownerPool = new Pool({ connectionString: ownerUrl, max: 1 });

export const runtimePool = new Pool({ connectionString: runtimeUrl, max: 1 });

export const runs = createWorkflowRunDatabase(
  parseDatabaseConfig({ connectionString: runtimeUrl, max: 2 }),
);

export const workspaceDatabase = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: runtimeUrl, max: 1 }),
);

export const person = randomUUID();

export const busyWorkspace = randomUUID();

export const quietWorkspace = randomUUID();

export const intake = randomUUID();

export const sync = randomUUID();

export const elsewhere = randomUUID();

/** Runs a statement in one workspace's context, as the owner or API role. */
export async function inWorkspace<Row extends Record<string, unknown>>(
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
export async function addWorkflows(
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
export async function addRuns(
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

export const zero = {
  queued: 0,
  running: 0,
  waiting: 0,
  succeeded: 0,
  failed: 0,
  canceled: 0,
  timed_out: 0,
  outcome_unknown: 0,
};

export async function beforeAllFixture1() {
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

export async function beforeEachFixture2() {
  await inWorkspace('owner', busyWorkspace, {
    text: `truncate table app.workflow_runs, app.workflow_versions, app.workflows,
       app.workspace_memberships, app.workspaces, app.users, app.artifacts,
       app.workspace_artifact_capacity cascade`,
  });
  await seedWorkspaces();
}

export async function afterAllFixture3() {
  const closed = await Promise.allSettled([
    runs.close(),
    workspaceDatabase.close(),
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
