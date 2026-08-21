import { readFile } from 'node:fs/promises';

import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  CoordinatorPlanInvalidError,
  createCoordinatorRunStore,
} from '../src/coordinator-run-store.js';
import { runCheckpoints, workflowRuns } from '../src/schema.js';

const migrationUrl = new URL(
  '../migrations/0015_coordinator_run_store.sql',
  import.meta.url,
);
const invocationKeyMigrationUrl = new URL(
  '../migrations/0016_engine_invocation_keys.sql',
  import.meta.url,
);

describe('coordinator run store contract', () => {
  it('adds the checkpoint-to-run executable identity binding additively', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain('ADD COLUMN workflow_version_id uuid');
    expect(sql).toContain('ALTER COLUMN workflow_version_id SET NOT NULL');
    expect(sql).toContain('run_checkpoints_run_version_workspace_fk');
    expect(sql).toContain('ON DELETE CASCADE');
    expect(sql).toContain(
      'GRANT UPDATE (last_transition_fingerprint)\n  ON app.run_checkpoints TO {{worker_runtime_role}}',
    );
    expect(sql).not.toMatch(/GRANT\s+(?:INSERT|DELETE|TRUNCATE)/iu);
  });

  it('widens invocation identities without rewriting retained rows', async () => {
    const sql = await readFile(invocationKeyMigrationUrl, 'utf8');

    expect(sql).toContain('DROP CONSTRAINT node_runs_invocation_key_format');
    expect(sql).toContain(
      "invocation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$'",
    );
    expect(sql).toContain('%[0-9A-F]{2})+\\|');
    expect(sql).toContain('\\|b:');
    expect(sql).toContain('\\|i:');
    expect(sql).not.toMatch(/UPDATE\s+app\.node_runs/iu);
  });

  it('maps transition fingerprints only on the checkpoint projection', () => {
    expect(getTableColumns(runCheckpoints).lastTransitionFingerprint.name).toBe(
      'last_transition_fingerprint',
    );
    expect('lastTransitionFingerprint' in getTableColumns(workflowRuns)).toBe(
      false,
    );
  });

  it('rejects a plan that omits the engine event cursor before opening PostgreSQL', async () => {
    const store = createCoordinatorRunStore({
      connectionString: 'postgresql://invalid.invalid/pertexo',
      connectionTimeoutMillis: 1_000,
      idleTimeoutMillis: 1_000,
      max: 1,
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    });

    await expect(
      store.commitAdvancePlan({
        workspaceId: '00000000-0000-4000-8000-000000000001',
        runId: '00000000-0000-4000-8000-000000000002',
      } as never),
    ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);
    await store.close();
  });

  it('honors an already-aborted load without opening PostgreSQL', async () => {
    const store = createCoordinatorRunStore({
      connectionString: 'postgresql://invalid.invalid/pertexo',
      connectionTimeoutMillis: 1_000,
      idleTimeoutMillis: 1_000,
      max: 1,
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      store.loadAdvanceState({
        workspaceId: '00000000-0000-4000-8000-000000000001',
        runId: '00000000-0000-4000-8000-000000000002',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await store.close();
  });

  it('handles a pool connection failure after acquisition is aborted', async () => {
    const store = createCoordinatorRunStore({
      connectionString: 'postgresql://127.0.0.1:1/pertexo',
      connectionTimeoutMillis: 25,
      idleTimeoutMillis: 25,
      max: 1,
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    });
    const controller = new AbortController();
    const pending = store.loadAdvanceState({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      runId: '00000000-0000-4000-8000-000000000002',
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await store.close();
  });
});
