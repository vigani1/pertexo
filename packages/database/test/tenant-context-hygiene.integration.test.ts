import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../src/migrations.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';
import {
  withPlatformTransaction,
  withTenantScopedClient,
  withWorkspaceTransaction,
} from '../src/tenant-access/workspace.js';

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
const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: [
    'pertexo_migration',
    'pertexo_api',
    'pertexo_worker',
    'pertexo_dispatcher',
  ],
  databaseName,
  ownerRole: 'pertexo_owner',
});

function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const apiPool = new Pool({
  connectionString: databaseUrl(apiBaseUrl),
  max: 1,
});
const admin = new Pool({ connectionString: adminUrl, max: 1 });

async function backendId(client: Pick<Pool, 'query'>): Promise<number> {
  const result = await client.query<{ pid: number }>(
    'select pg_backend_pid() pid',
  );
  const pid = result.rows[0]?.pid;
  if (pid === undefined)
    throw new Error('PostgreSQL backend identity is absent');
  return pid;
}

async function waitForBackendAbsent(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    const result = await admin.query<{ present: boolean }>(
      `select exists(select 1 from pg_stat_activity
        where datname=$1 and pid=$2) present`,
      [databaseName, pid],
    );
    if (result.rows[0]?.present === false) return;
    await admin.query('select pg_sleep(0.02)');
  } while (Date.now() < deadline);
  throw new Error(`PostgreSQL backend ${String(pid)} did not disconnect`);
}

async function waitForSlowQuery(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    const result = await admin.query<{ entered: boolean }>(
      `select exists(select 1 from pg_stat_activity
        where datname=$1 and pid=$2 and state='active'
          and query like '%pg_sleep(5)%') entered`,
      [databaseName, pid],
    );
    if (result.rows[0]?.entered === true) return;
    await admin.query('select pg_sleep(0.02)');
  } while (Date.now() < deadline);
  throw new Error(`PostgreSQL backend ${String(pid)} did not enter slow query`);
}

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
  await fixture.create();
  await migrateDatabase({
    connectionString: databaseUrl(migrationBaseUrl),
    ownerRole: 'pertexo_owner',
    apiRuntimeRole: 'pertexo_api',
    workerRuntimeRole: 'pertexo_worker',
    dispatcherRole: 'pertexo_dispatcher',
    maintenanceRole: 'pertexo_maintenance',
    lifecycleCommandRole: 'pertexo_lifecycle_command',
    operatorRole: 'pertexo_operator',
  });
}, 60_000);

afterAll(async () => {
  const failures: unknown[] = [];
  try {
    await apiPool.end();
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    await fixture.drop();
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    await admin.end();
  } catch (error: unknown) {
    failures.push(error);
  }
  if (failures.length > 0)
    throw new AggregateError(failures, 'Tenant hygiene fixture cleanup failed');
});

describe('tenant-scoped transaction hygiene', () => {
  it('keeps platform-global transactions context-free on the shared hardened path', async () => {
    await expect(
      withPlatformTransaction(apiPool, async (client) =>
        currentSettings(client),
      ),
    ).resolves.toEqual({ workspaceId: null, actorId: null });

    const leakedWorkspaceId = randomUUID();
    let contaminatedBackend: number | undefined;
    const error = (await captureRejection(() =>
      withPlatformTransaction(apiPool, async (client) => {
        contaminatedBackend = await backendId(client);
        await client.query("select set_config('app.workspace_id', $1, false)", [
          leakedWorkspaceId,
        ]);
      }),
    )) as AggregateError;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toBe('Platform context cleanup failed');
    expect(contaminatedBackend).toBeDefined();
    await waitForBackendAbsent(contaminatedBackend ?? -1);

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
});
