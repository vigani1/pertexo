import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { expect, it } from 'vitest';

import {
  withTenantScopedClient,
  withWorkspaceTransaction,
} from '../../../src/tenant-access/transactions.js';
import {
  apiPool,
  backendId,
  waitForBackendAbsent,
  waitForSlowQuery,
  currentSettings,
  captureRejection,
} from './fixture.js';

export function registerDestroysPooledClientLeaksWorkspace(): void {
  it('destroys a pooled client that leaks workspace context through the commit path', async () => {
    const workspaceId = randomUUID();
    let contaminatedBackend: number | undefined;
    const error = (await captureRejection(() =>
      withTenantScopedClient(apiPool, { workspaceId }, async (client) => {
        // A session-level setting (local = false) survives COMMIT and must be
        // detected after the transaction instead of returning the client to
        // the pool contaminated.
        contaminatedBackend = await backendId(client);
        await client.query("select set_config('app.workspace_id', $1, false)", [
          workspaceId,
        ]);
        return 'committed';
      }),
    )) as AggregateError;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toBe('Tenant context cleanup failed');
    expect(error.errors).toHaveLength(2);
    expect(contaminatedBackend).toBeDefined();
    await waitForBackendAbsent(contaminatedBackend ?? -1);

    // The destroyed client must not be reused: the next checkout is clean.
    const fresh = await apiPool.connect();
    try {
      await expect(currentSettings(fresh)).resolves.toEqual({
        workspaceId: null,
        actorId: null,
      });
      await expect(backendId(fresh)).resolves.not.toBe(contaminatedBackend);
    } finally {
      fresh.release();
    }
  });

  it('rolls back cleanly, preserves the original error, and keeps the client reusable', async () => {
    // PostgreSQL reverts even session-level settings when a transaction
    // aborts, so the rollback path cannot leak context the way COMMIT can.
    // The contract here is therefore: original error surfaces untouched,
    // no spurious AggregateError, and the pool client stays usable.
    const workspaceId = randomUUID();
    let rolledBackBackend: number | undefined;
    const error = await captureRejection(() =>
      withTenantScopedClient(apiPool, { workspaceId }, async (client) => {
        rolledBackBackend = await backendId(client);
        await client.query("select set_config('app.actor_id', $1, true)", [
          'hygiene-probe',
        ]);
        throw new Error('operation failed');
      }),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('operation failed');

    const fresh = await apiPool.connect();
    try {
      await expect(currentSettings(fresh)).resolves.toEqual({
        workspaceId: null,
        actorId: null,
      });
      await expect(backendId(fresh)).resolves.toBe(rolledBackBackend);
    } finally {
      fresh.release();
    }
  });

  it('aborts an in-flight query through the wire-level cancellation seam', async () => {
    const workspaceId = randomUUID();
    const controller = new AbortController();
    let reportBackend!: (pid: number) => void;
    const backendReported = new Promise<number>((resolve) => {
      reportBackend = resolve;
    });
    const startedAt = Date.now();
    const slow = withTenantScopedClient(
      apiPool,
      { workspaceId },
      async (client) => {
        reportBackend(await backendId(client));
        await client.query('select pg_sleep(5)');
        return 'finished';
      },
      { signal: controller.signal },
    );
    void slow.catch(() => undefined);
    let entryTimer: ReturnType<typeof setTimeout> | undefined;
    const entryTimeout = new Promise<never>((_resolve, reject) => {
      entryTimer = setTimeout(() => {
        reject(
          new Error('Tenant cancellation callback did not acquire a backend'),
        );
      }, 2_000);
    });
    let canceledBackend: number;
    try {
      canceledBackend = await Promise.race([backendReported, entryTimeout]);
    } catch (error: unknown) {
      controller.abort();
      await slow.catch(() => undefined);
      throw error;
    } finally {
      if (entryTimer !== undefined) clearTimeout(entryTimer);
    }
    await waitForSlowQuery(canceledBackend);
    controller.abort();
    await expect(slow).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await waitForBackendAbsent(canceledBackend);

    const fresh = await apiPool.connect();
    try {
      await expect(currentSettings(fresh)).resolves.toEqual({
        workspaceId: null,
        actorId: null,
      });
      await expect(backendId(fresh)).resolves.not.toBe(canceledBackend);
    } finally {
      fresh.release();
    }
  });

  it('verifies and cleans both context settings on the success path', async () => {
    const workspaceId = randomUUID();
    const actorId = 'hygiene-success-probe';
    await expect(
      withTenantScopedClient(
        apiPool,
        { workspaceId, actorId },
        async (client) => currentSettings(client),
      ),
    ).resolves.toEqual({ workspaceId, actorId });
  });

  it('keeps the drizzle-backed workspace transaction working on top of the shared primitive', async () => {
    const workspaceId = randomUUID();
    await expect(
      withWorkspaceTransaction(apiPool, workspaceId, async (transaction) => {
        const result = await transaction.db.execute(
          sql`select current_setting('app.workspace_id', true) as workspace_id`,
        );
        const rows = result.rows as { workspace_id: string }[];
        return rows[0]?.workspace_id;
      }),
    ).resolves.toBe(workspaceId);
  });
}
