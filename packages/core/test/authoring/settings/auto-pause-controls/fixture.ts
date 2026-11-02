import { waitForBlockedBy } from '../../../support/postgres/lock-coordination.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect } from 'vitest';
import {
  migrateDatabase,
  parseDatabaseConfig,
  createDisposableDatabaseFixture,
} from '@pertexo/database/testing';
import {
  createIdentityWorkspaceStore,
  createWorkflowAuthoringStore,
} from '../../../../src/testing.js';

import { createWorkflowTriggerPauseFoldStore } from '../../../../src/triggers/pause/fold.store.js';

import { testExecutableCompiler } from '../../../../src/authoring/test-executable-compiler.js';

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

export const maintenanceUrl = url(
  'DATABASE_MAINTENANCE_URL',
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
);

export let identity: ReturnType<typeof createIdentityWorkspaceStore>;

export let authoring: ReturnType<typeof createWorkflowAuthoringStore>;

export let fold: ReturnType<typeof createWorkflowTriggerPauseFoldStore>;

export let admin: Pool;

let api: Pool;

export let worker: Pool;

function closeStore(store: { close(): Promise<void> } | undefined) {
  return store?.close();
}

function closePool(pool: Pool | undefined) {
  return pool?.end();
}

export const controls = () => {
  const result = authoring.autoPause;
  return result;
};

export async function seed() {
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

export async function outcome(
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

export async function pause(scope: Scope) {
  await controls().updateWorkflowSettings({
    ...scope,
    enabled: true,
    thresholdOverride: 3,
    expectedSettingsRevision: 1,
    idempotencyKey: randomUUID(),
  });
  for (let index = 0; index < 3; index++) await outcome(scope);
  await fold.foldPending(1000);
  expect((await controls().readWorkflowSettings(scope)).pauseState).toBe(
    'paused',
  );
}

export async function failures(scope: Scope) {
  const result = await admin.query<{ consecutive_failures: number }>(
    'select consecutive_failures from app.workflow_failure_streaks where workspace_id=$1 and workflow_id=$2',
    [scope.workspaceId, scope.workflowId],
  );
  return result.rows[0]?.consecutive_failures;
}

export async function auditCount(scope: Scope, action: string) {
  const result = await admin.query<{ count: number }>(
    'select count(*)::int as count from app.audit_events where workspace_id=$1 and action=$2',
    [scope.workspaceId, action],
  );
  return result.rows[0]?.count;
}

export async function pausePeriodCount(scope: Scope) {
  const result = await admin.query<{ count: number }>(
    'select count(*)::int as count from app.workflow_trigger_pause_periods where workspace_id=$1 and workflow_id=$2',
    [scope.workspaceId, scope.workflowId],
  );
  return result.rows[0]?.count;
}

export async function waitForBlocked(pid: number) {
  await waitForBlockedBy(admin, pid);
}

export async function beforeAllFixture1() {
  await fixture.create();
  await migrateDatabase({
    connectionString: migrationUrl,
    ownerRole: 'pertexo_owner',
    appRole: 'pertexo_app',
    maintenanceRole: 'pertexo_maintenance',
  });
  identity = createIdentityWorkspaceStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  );
  authoring = createWorkflowAuthoringStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 6 }),
    { executableCompiler: testExecutableCompiler },
  );
  fold = createWorkflowTriggerPauseFoldStore(
    parseDatabaseConfig({ connectionString: workerUrl, max: 6 }),
  );
  admin = new Pool({ connectionString: fixture.databaseUrl(adminUrl), max: 4 });
  api = new Pool({ connectionString: apiUrl, max: 2 });
  worker = new Pool({ connectionString: workerUrl, max: 2 });
}

export async function afterAllFixture2() {
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
}
