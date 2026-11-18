import { testStackSetting } from '../../../../infrastructure/testing/test-stack.mjs';
import { maintenanceConfig } from '../../../../infrastructure/testing/worker-databases.mjs';
import { randomUUID } from 'node:crypto';

import { createIdentityWorkspaceStore } from '@pertexo/core/testing';
import { createWorkflowTriggerPauseFoldStore } from '@pertexo/core/triggers';
import {
  createDisposableDatabaseFixture,
  migrateDatabase,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { createWorkflowAutoPauseRuntime } from '../../src/workflows/auto-pause.runtime.js';

const fixture = createDisposableDatabaseFixture({
  adminUrl: testStackSetting('DATABASE_ADMIN_URL'),
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
  databaseName: `pertexo_test_auto_pause_${randomUUID().replaceAll('-', '')}`,
  ownerRole: 'pertexo_owner',
});
const url = (variable: string) =>
  fixture.databaseUrl(testStackSetting(variable));

let admin: Pool;

beforeAll(async () => {
  await fixture.create();
  await migrateDatabase({
    appRole: 'pertexo_app',
    connectionString: url('DATABASE_MIGRATION_URL'),
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
  });
  admin = new Pool({ connectionString: url('DATABASE_ADMIN_URL'), max: 1 });
});

afterAll(async () => {
  await admin.end();
  await fixture.drop();
});

/** A workflow whose schedule ended in `failures` failed runs, not yet folded. */
async function failingWorkflow(failures: number) {
  const identity = createIdentityWorkspaceStore(
    parseDatabaseConfig({ connectionString: url('DATABASE_URL'), max: 1 }),
  );
  const workflowId = randomUUID();
  const runIds: string[] = [];
  let workspaceId: string;
  try {
    const owner = await identity.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Owner',
    });
    workspaceId = (
      await identity.createWorkspaceWithOwner({
        name: 'Auto-pause runtime',
        slug: `auto-pause-${randomUUID().slice(0, 8)}`,
        ownerUserId: owner.id,
      })
    ).id;
    await admin.query(
      `insert into app.workspace_execution_entitlement_versions
         (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
       values ($1,2,'active',100,1000,'-infinity'::timestamptz)`,
      [workspaceId],
    );
    await admin.query(
      'update app.workspace_execution_entitlements set current_version=2 where workspace_id=$1',
      [workspaceId],
    );
    await admin.query(
      'insert into app.workflows (id,workspace_id,name,created_by) values ($1,$2,$3,$4)',
      [workflowId, workspaceId, 'Nightly import', owner.id],
    );
    for (let index = 0; index < failures; index += 1) {
      const [run] = (
        await admin.query<{ id: string }>(
          `with tenant as (select set_config('app.workspace_id',$1::uuid::text,true))
             insert into app.workflow_runs (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status)
             select gen_random_uuid(),$1::uuid,$2::uuid,gen_random_uuid(),'schedule','failed' from tenant
             returning id`,
          [workspaceId, workflowId],
        )
      ).rows;
      if (run === undefined) throw new Error('run was not created');
      runIds.push(run.id);
    }
  } finally {
    await identity.close();
  }
  // The run's terminal transition writes exactly these rows as the worker role.
  const worker = new Pool({ connectionString: url('DATABASE_URL'), max: 1 });
  const client = await worker.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    for (const runId of runIds)
      await client.query(
        `insert into app.workflow_trigger_outcomes
           (id,workspace_id,workflow_id,run_id,counts_as_failure,ended_at)
         values ($1,$2,$3,$4,true,clock_timestamp())`,
        [randomUUID(), workspaceId, workflowId, runId],
      );
    await client.query('commit');
  } finally {
    client.release();
    await worker.end();
  }
  return { workspaceId, workflowId };
}

it('folds a burst of failure streaks back to back and pauses each workflow that reaches its threshold', async () => {
  const first = await failingWorkflow(12);
  const second = await failingWorkflow(12);
  const add = vi.fn();
  const diagnostics = { cycleFailed: vi.fn(), decided: vi.fn() };
  const runtime = createWorkflowAutoPauseRuntime(
    createWorkflowTriggerPauseFoldStore(
      maintenanceConfig(
        parseDatabaseConfig({ connectionString: url('DATABASE_URL'), max: 2 }),
      ),
    ),
    // One workflow's outcomes per fold, and a poll far past the test: the
    // runtime folds again at once only while a fold pauses something, so the
    // second pause must come from folding back to back in the first cycle.
    { foldBatchSize: 12, foldPollMillis: 60_000 },
    diagnostics,
    { createCounter: () => ({ add }) } as never,
  );
  await expect(runtime.checkReadiness()).rejects.toThrow(
    'Workflow auto-pause runtime has not started',
  );
  try {
    runtime.start();
    await expect(runtime.checkReadiness()).resolves.toBeUndefined();

    expect(diagnostics.decided.mock.calls).toEqual(
      expect.arrayContaining([
        [{ ...first, consecutiveFailures: 12 }],
        [{ ...second, consecutiveFailures: 12 }],
      ]),
    );
    expect(diagnostics.decided).toHaveBeenCalledTimes(2);
    expect(add.mock.calls).toEqual([
      [1, { outcome: 'paused' }],
      [1, { outcome: 'paused' }],
    ]);
    expect(diagnostics.cycleFailed).not.toHaveBeenCalled();
    const paused = await admin.query<{ id: string; state: string }>(
      `select id,trigger_pause_state as state from app.workflows
        where id = any($1) order by id`,
      [[first.workflowId, second.workflowId]],
    );
    expect(paused.rows.map(({ state }) => state)).toEqual(['paused', 'paused']);
    const pending = await admin.query(
      'select 1 from app.workflow_trigger_outcomes where workflow_id = any($1)',
      [[first.workflowId, second.workflowId]],
    );
    expect(pending.rowCount).toBe(0);
  } finally {
    await runtime.close();
  }
  await expect(runtime.checkReadiness()).rejects.toThrow(
    'Workflow auto-pause runtime is closed',
  );
});
