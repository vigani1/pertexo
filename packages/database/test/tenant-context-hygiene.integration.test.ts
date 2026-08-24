import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../src/migrations.js';
import { dropDisconnectedDatabase } from './support/disposable-database.js';
import {
  withTenantScopedClient,
  withWorkspaceTransaction,
} from '../src/workspace.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';

const databaseName = `pertexo_test_tenant_hygiene_${randomUUID().replaceAll('-', '')}`;

function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const apiPool = new Pool({
  connectionString: databaseUrl(apiBaseUrl),
  max: 3,
});

async function currentSettings(
  client: Pick<Pool, 'query'>,
): Promise<{ workspaceId: string | null; actorId: string | null }> {
  const result = await client.query<{
    workspace_id: string | null;
    actor_id: string | null;
  }>(
    "select current_setting('app.workspace_id', true) as workspace_id, current_setting('app.actor_id', true) as actor_id",
  );
  // The hygiene contract treats missing and empty as equally clean.
  const clean = (value: string | null | undefined): string | null =>
    value === undefined || value === null || value === '' ? null : value;
  return {
    workspaceId: clean(result.rows[0]?.workspace_id),
    actorId: clean(result.rows[0]?.actor_id),
  };
}

async function captureRejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the transaction to reject');
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase({
    connectionString: databaseUrl(migrationBaseUrl),
    ownerRole: 'pertexo_owner',
    apiRuntimeRole: 'pertexo_api',
    workerRuntimeRole: 'pertexo_worker',
    dispatcherRole: 'pertexo_dispatcher',
  });
}, 60_000);

afterAll(async () => {
  await apiPool.end();
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
});

describe('tenant-scoped transaction hygiene', () => {
  it('destroys a pooled client that leaks workspace context through the commit path', async () => {
    const workspaceId = randomUUID();
    const error = (await captureRejection(() =>
      withTenantScopedClient(apiPool, { workspaceId }, async (client) => {
        // A session-level setting (local = false) survives COMMIT and must be
        // detected after the transaction instead of returning the client to
        // the pool contaminated.
        await client.query("select set_config('app.workspace_id', $1, false)", [
          workspaceId,
        ]);
        return 'committed';
      }),
    )) as AggregateError;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toBe('Tenant context cleanup failed');
    expect(error.errors).toHaveLength(2);

    // The destroyed client must not be reused: the next checkout is clean.
    const fresh = await apiPool.connect();
    try {
      await expect(currentSettings(fresh)).resolves.toEqual({
        workspaceId: null,
        actorId: null,
      });
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
    const error = await captureRejection(() =>
      withTenantScopedClient(apiPool, { workspaceId }, async (client) => {
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
    } finally {
      fresh.release();
    }
  });

  it('aborts an in-flight query through the wire-level cancellation seam', async () => {
    const workspaceId = randomUUID();
    const controller = new AbortController();
    const startedAt = Date.now();
    const slow = withTenantScopedClient(
      apiPool,
      { workspaceId },
      async (client) => {
        await client.query('select pg_sleep(5)');
        return 'finished';
      },
      { signal: controller.signal },
    );
    setTimeout(() => {
      controller.abort();
    }, 100);
    await expect(slow).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    const fresh = await apiPool.connect();
    try {
      await expect(currentSettings(fresh)).resolves.toEqual({
        workspaceId: null,
        actorId: null,
      });
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
});
