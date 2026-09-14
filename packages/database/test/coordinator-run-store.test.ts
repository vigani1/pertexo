import { readFile } from 'node:fs/promises';

import { getTableColumns } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  CoordinatorPlanInvalidError,
  createCoordinatorRunStore,
} from '../src/execution/coordinator-run-store.js';
import { createDatabaseRuntime } from '../src/platform/database-runtime.js';
import { runCheckpoints, workflowRuns } from '../src/schema.js';

const noNetworkConfig = {
  connectionString: 'postgresql://invalid.invalid/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 1_000,
  max: 1,
  ownerRole: 'pertexo_owner' as const,
  workerRuntimeRole: 'pertexo_worker' as const,
};

async function withNoNetworkStore<T>(
  operation: (
    store: ReturnType<typeof createCoordinatorRunStore>,
  ) => Promise<T>,
): Promise<T> {
  const connect = vi.spyOn(Pool.prototype, 'connect').mockImplementation(() => {
    throw new Error('Unexpected PostgreSQL checkout');
  });
  const runtime = createDatabaseRuntime(noNetworkConfig, {
    monitorLockWaits: false,
  });
  const store = createCoordinatorRunStore(noNetworkConfig, runtime);
  try {
    return await operation(store);
  } finally {
    connect.mockRestore();
    await Promise.all([store.close(), runtime.close()]);
  }
}

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
    await withNoNetworkStore(async (store) => {
      const workflowVersionId = '00000000-0000-4000-8000-000000000003';
      await expect(
        store.commitAdvancePlan({
          workspaceId: '00000000-0000-4000-8000-000000000001',
          runId: '00000000-0000-4000-8000-000000000002',
          workflowVersionId,
          signal: new AbortController().signal,
          delivery: {
            outboxEventId: '00000000-0000-4000-8000-000000000004',
            payloadChecksum: 'a'.repeat(64),
          },
          plan: {
            expectedRevision: 0,
            consumedThroughEventSequence: 1,
            checkpoint: {
              schemaVersion: 1,
              engineVersion: 'engine-v1',
              workflowVersionId,
              revision: 1,
              runStatus: 'running',
              nextEventSequence: 3,
              readySet: [],
              admittedInvocationKeys: [],
              invocations: [],
              joins: [],
              loops: [],
              remainingIterationBudget: 0,
              cancelRequested: false,
              deadlineExpired: false,
            },
            events: [
              {
                schemaVersion: 1,
                sequence: 2,
                name: 'run.started',
                occurredAt: '2026-09-13T00:00:00.000Z',
              },
            ],
            nodeRunAdmissions: [],
            attempts: [],
          },
        }),
      ).rejects.toBeInstanceOf(CoordinatorPlanInvalidError);
    });
  });

  it('honors an already-aborted load without opening PostgreSQL', async () => {
    const controller = new AbortController();
    controller.abort();
    await withNoNetworkStore(async (store) => {
      await expect(
        store.loadAdvanceState({
          workspaceId: '00000000-0000-4000-8000-000000000001',
          runId: '00000000-0000-4000-8000-000000000002',
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });
  });

  it('disposes a controlled late checkout after acquisition is aborted', async () => {
    let resolveCheckout!: (client: PoolClient) => void;
    const checkout = new Promise<PoolClient>((resolve) => {
      resolveCheckout = resolve;
    });
    const connect = vi
      .spyOn(Pool.prototype, 'connect')
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- This exercises the promise overload of pg Pool.connect.
      .mockImplementation((() => checkout) as typeof Pool.prototype.connect);
    const runtime = createDatabaseRuntime(noNetworkConfig, {
      monitorLockWaits: false,
    });
    const store = createCoordinatorRunStore(noNetworkConfig, runtime);
    const controller = new AbortController();
    const release = vi.fn();
    try {
      const pending = store.loadAdvanceState({
        workspaceId: '00000000-0000-4000-8000-000000000001',
        runId: '00000000-0000-4000-8000-000000000002',
        signal: controller.signal,
      });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      resolveCheckout({ release } as unknown as PoolClient);
      await vi.waitFor(() => {
        expect(
          release.mock.calls.some(([reason]) => reason instanceof Error),
        ).toBe(true);
      });
    } finally {
      connect.mockRestore();
      await Promise.all([store.close(), runtime.close()]);
    }
  });
});
