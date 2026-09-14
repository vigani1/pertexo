import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import type { DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createWorkspaceDatabase } from '../src/database.js';
import type { WorkspaceDatabase } from '../src/database.js';
import { migrateDatabase } from '../src/migrations.js';
import { rlsProbeRecords } from '../src/schema.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerBaseUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const databaseName = `pertexo_test_rls_${randomUUID().replaceAll('-', '')}`;
const inheritedRole = `pertexo_test_inherited_${randomUUID().replaceAll('-', '')}`;
const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: [
    new URL(adminUrl).username,
    'pertexo_migration',
    'pertexo_api',
    'pertexo_worker',
  ],
  databaseName,
  ownerRole: 'pertexo_owner',
});
const migrationUrl = fixture.databaseUrl(migrationBaseUrl);
const apiUrl = fixture.databaseUrl(apiBaseUrl);
const workerUrl = fixture.databaseUrl(workerBaseUrl);
const adminPool = new Pool({ connectionString: adminUrl, max: 1 });
const databaseAdminPool = new Pool({
  connectionString: fixture.databaseUrl(adminUrl),
  max: 1,
});

const workspaceA = randomUUID();
const workspaceB = randomUUID();
const recordA = randomUUID();
const recordB = randomUUID();
let database: WorkspaceDatabase;
let ownerPool: Pool;

const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: migrationUrl,
  dispatcherRole: 'pertexo_dispatcher',
  maintenanceRole: 'pertexo_maintenance',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  operatorRole: 'pertexo_operator',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

function expectPgCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    let current: unknown = error;
    const visited = new WeakSet<object>();
    for (let depth = 0; depth < 32 && current instanceof Error; depth += 1) {
      if (visited.has(current)) return false;
      visited.add(current);
      if ((current as DatabaseError).code === code) {
        return true;
      }
      current = current.cause;
    }
    return false;
  };
}

async function executeAsOwner(statement: string): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query(statement);
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await fixture.create();
  await migrateDatabase(migrationConfig);
  ownerPool = new Pool({ connectionString: migrationUrl, max: 1 });
  database = createWorkspaceDatabase(
    parseDatabaseConfig({
      connectionString: apiUrl,
      max: 1,
      ownerRole: 'pertexo_owner',
    }),
  );
  await database.withWorkspace(workspaceA, async ({ db, workspaceId }) => {
    await db.insert(rlsProbeRecords).values({
      id: recordA,
      workspaceId,
      label: 'workspace-a',
    });
  });
  await database.withWorkspace(workspaceB, async ({ db, workspaceId }) => {
    await db.insert(rlsProbeRecords).values({
      id: recordB,
      workspaceId,
      label: 'workspace-b',
    });
  });
}, 60_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const cleanup: (() => Promise<void>)[] = [];
  // beforeAll can fail before these runtime owners are assigned.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (database !== undefined) cleanup.push(() => database.close());
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (ownerPool !== undefined) cleanup.push(() => ownerPool.end());
  cleanup.push(() => databaseAdminPool.end());
  cleanup.push(() => fixture.drop());
  cleanup.push(async () => {
    await adminPool.query(`drop role if exists "${inheritedRole}"`);
  });
  cleanup.push(() => adminPool.end());
  for (const close of cleanup) {
    try {
      await close();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, 'RLS fixture cleanup failed');
});

describe('workspace transaction boundary', () => {
  it('keeps reviewed migrations idempotent after reaching head', async () => {
    await expect(migrateDatabase(migrationConfig)).resolves.toEqual([]);
  });

  it('returns only rows from the active workspace even for an unfiltered query', async () => {
    const rows = await database.withWorkspace(workspaceA, async ({ db }) =>
      db.select().from(rlsProbeRecords),
    );

    expect(rows.some((row) => row.id === recordA)).toBe(true);
    expect(rows.some((row) => row.id === recordB)).toBe(false);
  });

  it('cannot read, update, or delete another workspace explicitly', async () => {
    await database.withWorkspace(workspaceA, async ({ db }) => {
      const read = await db
        .select()
        .from(rlsProbeRecords)
        .where(eq(rlsProbeRecords.id, recordB));
      const updated = await db
        .update(rlsProbeRecords)
        .set({ label: 'tampered' })
        .where(eq(rlsProbeRecords.id, recordB))
        .returning();
      const deleted = await db
        .delete(rlsProbeRecords)
        .where(eq(rlsProbeRecords.id, recordB))
        .returning();

      expect(read).toEqual([]);
      expect(updated).toEqual([]);
      expect(deleted).toEqual([]);
    });
  });

  it('rejects a write carrying another workspace ID', async () => {
    await expect(
      database.withWorkspace(workspaceA, async ({ db }) => {
        await db.insert(rlsProbeRecords).values({
          id: randomUUID(),
          workspaceId: workspaceB,
          label: 'cross-tenant-write',
        });
      }),
    ).rejects.toSatisfy(expectPgCode('42501'));
  });

  it('rolls back failed operations', async () => {
    const rolledBackId = randomUUID();
    await expect(
      database.withWorkspace(workspaceA, async ({ db, workspaceId }) => {
        await db.insert(rlsProbeRecords).values({
          id: rolledBackId,
          workspaceId,
          label: 'must-roll-back',
        });
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    const rows = await database.withWorkspace(workspaceA, async ({ db }) =>
      db
        .select()
        .from(rlsProbeRecords)
        .where(eq(rlsProbeRecords.id, rolledBackId)),
    );
    expect(rows).toEqual([]);
  });

  it('does not leak context when one pooled connection changes workspaces', async () => {
    const aRows = await database.withWorkspace(workspaceA, async ({ db }) =>
      db.select().from(rlsProbeRecords),
    );
    const bRows = await database.withWorkspace(workspaceB, async ({ db }) =>
      db.select().from(rlsProbeRecords),
    );

    expect(aRows.some((row) => row.id === recordB)).toBe(false);
    expect(bRows.some((row) => row.id === recordA)).toBe(false);
  });

  it('cancels a blocked workspace query and destroys the pooled client', async () => {
    const controller = new AbortController();
    let queryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      queryStarted = resolve;
    });
    const startedAt = Date.now();
    const pending = database.withWorkspace(
      workspaceA,
      async ({ db }) => {
        queryStarted();
        await db.execute(sql`select pg_sleep(30)`);
      },
      { signal: controller.signal },
    );

    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    await expect(
      database.withWorkspace(workspaceA, async ({ db }) => {
        const result = await db.execute<{ workspace_id: string }>(sql`
          select current_setting('app.workspace_id', true) as workspace_id
        `);
        return result.rows[0]?.workspace_id;
      }),
    ).resolves.toBe(workspaceA);
  });

  it('isolates concurrent workspace transactions sharing one pool', async () => {
    const concurrentDatabase = createWorkspaceDatabase(
      parseDatabaseConfig({
        connectionString: apiUrl,
        max: 2,
        ownerRole: 'pertexo_owner',
      }),
    );
    let arrivals = 0;
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const readWorkspace = async (
      workspaceId: string,
    ): Promise<readonly string[]> =>
      concurrentDatabase.withWorkspace(workspaceId, async ({ db }) => {
        arrivals += 1;
        if (arrivals === 2) {
          releaseBarrier?.();
        }
        await barrier;
        const rows = await db.select().from(rlsProbeRecords);
        return rows.map((row) => row.id);
      });

    try {
      const [aIds, bIds] = await Promise.all([
        readWorkspace(workspaceA),
        readWorkspace(workspaceB),
      ]);
      expect(aIds).toContain(recordA);
      expect(aIds).not.toContain(recordB);
      expect(bIds).toContain(recordB);
      expect(bIds).not.toContain(recordA);
    } finally {
      releaseBarrier?.();
      await concurrentDatabase.close();
    }
  });

  it('drains the peer transaction when one participant fails before the barrier', async () => {
    const concurrentDatabase = createWorkspaceDatabase(
      parseDatabaseConfig({
        connectionString: apiUrl,
        max: 2,
        ownerRole: 'pertexo_owner',
      }),
    );
    const controller = new AbortController();
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const waiting = concurrentDatabase.withWorkspace(
      workspaceA,
      async () => barrier,
      { signal: controller.signal },
    );
    const failedBeforeCallback = concurrentDatabase.withWorkspace(
      'not-a-workspace-id',
      () => Promise.reject(new Error('callback must not run')),
    );

    try {
      await expect(failedBeforeCallback).rejects.toThrow();
    } finally {
      controller.abort();
      releaseBarrier();
      const outcomes = await Promise.allSettled([
        waiting,
        failedBeforeCallback,
      ]);
      expect(outcomes.every(({ status }) => status === 'rejected')).toBe(true);
      await concurrentDatabase.close();
    }
  });

  it('clears transaction-local context before the same client is reused', async () => {
    const pool = new Pool({ connectionString: apiUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      const scoped = await client.query<{ id: string }>(
        'select id from app.rls_probe_records',
      );
      expect(scoped.rows.some((row) => row.id === recordA)).toBe(true);
      await client.query('commit');

      await client.query('begin');
      const context = await client.query<{ workspace_id: string }>(
        "select current_setting('app.workspace_id', true) as workspace_id",
      );
      const unscoped = await client.query(
        'select id from app.rls_probe_records',
      );
      await client.query('commit');

      expect(context.rows[0]?.workspace_id ?? '').toBe('');
      expect(unscoped.rows).toEqual([]);

      await client.query('begin');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      await client.query('rollback');
      await client.query('begin');
      const afterRollback = await client.query<{ workspace_id: string }>(
        "select current_setting('app.workspace_id', true) as workspace_id",
      );
      const rollbackUnscoped = await client.query(
        'select id from app.rls_probe_records',
      );
      await client.query('commit');

      expect(afterRollback.rows[0]?.workspace_id ?? '').toBe('');
      expect(rollbackUnscoped.rows).toEqual([]);
    } finally {
      client.release();
      await pool.end();
    }
  });
});

describe.each([
  ['api', apiUrl],
  ['worker', workerUrl],
])('%s runtime database role', (_roleName, connectionString) => {
  it('fails closed without workspace context', async () => {
    const pool = new Pool({ connectionString, max: 1 });
    try {
      const read = await pool.query('select id from app.rls_probe_records');
      expect(read.rows).toEqual([]);
      await expect(
        pool.query(
          'insert into app.rls_probe_records (id, workspace_id, label) values ($1, $2, $3)',
          [randomUUID(), workspaceA, 'unscoped'],
        ),
      ).rejects.toSatisfy(expectPgCode('42501'));
    } finally {
      await pool.end();
    }
  });

  it('is neither privileged nor a member of the owner role', async () => {
    const pool = new Pool({ connectionString });
    try {
      const result = await pool.query<{
        owner_member: boolean;
        rolbypassrls: boolean;
        rolsuper: boolean;
      }>(`
        select
          role.rolsuper,
          role.rolbypassrls,
          exists (
            select 1
            from pg_auth_members membership
            join pg_roles owner_role on owner_role.oid = membership.roleid
            where membership.member = role.oid
              and owner_role.rolname = 'pertexo_owner'
          ) as owner_member
        from pg_roles role
        where role.rolname = current_user
      `);
      expect(result.rows[0]).toEqual({
        owner_member: false,
        rolbypassrls: false,
        rolsuper: false,
      });
    } finally {
      await pool.end();
    }
  });

  it('cannot disable row security at query time', async () => {
    const pool = new Pool({ connectionString });
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local row_security = off');
      await expect(
        client.query('select id from app.rls_probe_records'),
      ).rejects.toSatisfy(expectPgCode('42501'));
      await client.query('rollback');
    } finally {
      client.release();
      await pool.end();
    }
  });

  it.each([
    ['truncate table app.rls_probe_records', '42501'],
    ['alter table app.rls_probe_records disable row level security', '42501'],
    [
      'drop policy rls_probe_records_workspace_scope on app.rls_probe_records',
      '42501',
    ],
    ['set role pertexo_owner', '42501'],
    ['set role pertexo_migration', '42501'],
    ['set role pertexo_maintenance', '42501'],
  ])(
    'cannot execute privileged statement: %s',
    async (statement, expectedCode) => {
      const pool = new Pool({ connectionString });
      try {
        await expect(pool.query(statement)).rejects.toSatisfy(
          expectPgCode(expectedCode),
        );
      } finally {
        await pool.end();
      }
    },
  );
});

describe('database compatibility and readiness', () => {
  it('verifies bounded steady-state migration, PostgreSQL, and role readiness', async () => {
    await expect(database.checkReadiness()).resolves.toEqual({
      migrationHead: '0089_oidc_capacity_lock_time.sql',
      postgresMajor: 18,
      role: 'pertexo_api',
    });
  });

  it('detects a missing workspace policy', async () => {
    await executeAsOwner(
      'drop policy rls_probe_records_workspace_scope on app.rls_probe_records',
    );
    try {
      await expect(database.checkCompatibility()).rejects.toThrow(
        'Workspace row-level security policy is incompatible',
      );
    } finally {
      await executeAsOwner(`
          create policy rls_probe_records_workspace_scope
            on app.rls_probe_records
            for all
            to pertexo_api, pertexo_worker
            using (
              workspace_id::text = nullif(current_setting('app.workspace_id', true), '')
            )
            with check (
              workspace_id::text = nullif(current_setting('app.workspace_id', true), '')
            )
        `);
    }
  });

  it('rejects a weakened or additional permissive workspace policy', async () => {
    await executeAsOwner(`
      alter policy rls_probe_records_workspace_scope
        on app.rls_probe_records
        using (
          workspace_id::text = nullif(current_setting('app.workspace_id', true), '')
          or true
        )
        with check (
          workspace_id::text = nullif(current_setting('app.workspace_id', true), '')
          or true
        )
    `);
    try {
      await expect(database.checkCompatibility()).rejects.toThrow(
        'Workspace row-level security policy is incompatible',
      );
    } finally {
      await executeAsOwner(`
        alter policy rls_probe_records_workspace_scope
          on app.rls_probe_records
          using (
            workspace_id::text = nullif(current_setting('app.workspace_id', true), '')
          )
          with check (
            workspace_id::text = nullif(current_setting('app.workspace_id', true), '')
          )
      `);
    }

    await executeAsOwner(`
      create policy rls_probe_records_unexpected_permissive
        on app.rls_probe_records for select to pertexo_api using (true)
    `);
    try {
      await expect(database.checkCompatibility()).rejects.toThrow(
        'Workspace row-level security policy is incompatible',
      );
    } finally {
      await executeAsOwner(`
        drop policy rls_probe_records_unexpected_permissive
          on app.rls_probe_records
      `);
    }
    await expect(database.checkCompatibility()).resolves.toMatchObject({
      role: 'pertexo_api',
    });
  });

  it('detects an incompatible runtime grant', async () => {
    await executeAsOwner(
      'revoke insert on app.rls_probe_records from pertexo_api',
    );
    try {
      await expect(database.checkCompatibility()).rejects.toThrow(
        'Runtime database grants are incompatible',
      );
    } finally {
      await executeAsOwner(
        'grant insert on app.rls_probe_records to pertexo_api',
      );
    }
  });

  it('detects a forbidden effective column grant inherited by the worker', async () => {
    await adminPool.query(`create role "${inheritedRole}" nologin`);
    await executeAsOwner(
      `grant update (message_id) on app.inbox_receipts to "${inheritedRole}"`,
    );
    await adminPool.query(
      `grant "${inheritedRole}" to pertexo_worker with inherit true`,
    );
    const cleanupFailures: unknown[] = [];
    try {
      await expect(database.checkCompatibility()).rejects.toThrow(
        'Coordinator RunStore grants are incompatible',
      );
    } finally {
      for (const restore of [
        async (): Promise<void> => {
          await adminPool.query(
            `revoke "${inheritedRole}" from pertexo_worker`,
          );
        },
        (): Promise<void> =>
          executeAsOwner(
            `revoke update (message_id) on app.inbox_receipts from "${inheritedRole}"`,
          ),
        async (): Promise<void> => {
          await adminPool.query(`drop role "${inheritedRole}"`);
        },
      ])
        try {
          await restore();
        } catch (error: unknown) {
          cleanupFailures.push(error);
        }
    }
    if (cleanupFailures.length > 0)
      throw new AggregateError(
        cleanupFailures,
        'Inherited grant cleanup failed',
      );
    await expect(database.checkCompatibility()).resolves.toMatchObject({
      role: 'pertexo_api',
    });
  });

  it('detects a disabled OIDC capacity trigger', async () => {
    await executeAsOwner(
      'alter table app.oidc_login_transactions disable trigger oidc_login_transactions_capacity',
    );
    try {
      await expect(database.checkCompatibility()).rejects.toThrow(
        'OIDC login transaction capacity guard is incompatible',
      );
    } finally {
      await executeAsOwner(
        'alter table app.oidc_login_transactions enable trigger oidc_login_transactions_capacity',
      );
    }
  });

  it('detects a trigger with the right name but the wrong enforcement function', async () => {
    await executeAsOwner(`
      drop trigger connection_secret_versions_immutable
        on app.connection_secret_versions;
      create trigger connection_secret_versions_immutable
        before update or delete on app.connection_secret_versions
        for each row execute function app.reject_webhook_trigger_secret_version_mutation()
    `);
    try {
      await expect(database.checkCompatibility()).rejects.toThrow(
        'Connection persistence schema or grants are incompatible',
      );
    } finally {
      await executeAsOwner(`
        drop trigger connection_secret_versions_immutable
          on app.connection_secret_versions;
        create trigger connection_secret_versions_immutable
          before update or delete on app.connection_secret_versions
          for each row execute function app.reject_connection_history_change()
      `);
    }
    await expect(database.checkCompatibility()).resolves.toMatchObject({
      role: 'pertexo_api',
    });
  });

  it('detects a weakened check constraint under its expected name', async () => {
    await executeAsOwner(`
      alter table app.run_failure_notification_intents
        drop constraint run_failure_notification_intents_status_valid,
        add constraint run_failure_notification_intents_status_valid
          check (status is not null)
    `);
    try {
      await expect(database.checkCompatibility()).rejects.toThrow(
        'Run failure notification persistence is incompatible',
      );
    } finally {
      await executeAsOwner(`
        alter table app.run_failure_notification_intents
          drop constraint run_failure_notification_intents_status_valid,
          add constraint run_failure_notification_intents_status_valid check (
            status in (
              'pending','claimed','dispatching','retry','delivered',
              'dead_letter','outcome_unknown'
            )
          )
      `);
    }
    await expect(database.checkCompatibility()).resolves.toMatchObject({
      role: 'pertexo_api',
    });
  });

  it('detects a broadened function search path', async () => {
    await executeAsOwner(`
      alter function app.consume_webhook_ingress_limit(character)
        set search_path=pg_catalog,app,pg_temp,public
    `);
    try {
      await expect(database.checkCompatibility()).rejects.toThrow(
        'Webhook trigger persistence is incompatible',
      );
    } finally {
      await executeAsOwner(`
        alter function app.consume_webhook_ingress_limit(character)
          set search_path=pg_catalog,app,pg_temp
      `);
    }
    await expect(database.checkCompatibility()).resolves.toMatchObject({
      role: 'pertexo_api',
    });
  });

  it('detects when forced row-level security is removed', async () => {
    await executeAsOwner(
      'alter table app.rls_probe_records no force row level security',
    );
    try {
      await expect(database.checkCompatibility()).rejects.toThrow(
        'Protected table does not force row-level security',
      );
    } finally {
      await executeAsOwner(
        'alter table app.rls_probe_records force row level security',
      );
    }
  });

  it('detects a protected table owner change', async () => {
    await databaseAdminPool.query(
      'alter table app.rls_probe_records owner to pertexo_migration',
    );
    try {
      await expect(database.checkCompatibility()).rejects.toThrow(
        'Protected table has an unexpected owner',
      );
    } finally {
      await databaseAdminPool.query(
        'alter table app.rls_probe_records owner to pertexo_owner',
      );
    }
    await expect(database.checkCompatibility()).resolves.toMatchObject({
      role: 'pertexo_api',
    });
  });

  it('detects an incompatible migration head', async () => {
    await executeAsOwner(`
        insert into pertexo_internal.schema_migrations (name, checksum)
        values ('9999_incompatible.sql', 'test-only')
      `);
    try {
      await expect(database.checkReadiness()).rejects.toThrow(
        'Database migration head is incompatible',
      );
    } finally {
      await executeAsOwner(`
          delete from pertexo_internal.schema_migrations
          where name = '9999_incompatible.sql'
        `);
    }
  });
});
