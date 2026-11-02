import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiUrl,
  workerUrl,
  workspaceA,
  expectPgCode,
  beforeAllFixture1,
  afterAllFixture2,
  workspaceB,
  recordA,
  recordB,
  database,
  migrationConfig,
  executeAsOwner,
} from './rls/fixture.js';
import { eq, sql } from 'drizzle-orm';
import { parseDatabaseConfig } from '../../src/config.js';
import { createWorkspaceDatabase } from '../../src/database.js';
import { migrateDatabase } from '../../src/migrations.js';
import { rlsProbeRecords } from '../../src/schema.js';
import { EXPECTED_MIGRATION_HEAD } from '../../src/platform/readiness.queries.js';

beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);
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
    const failedParticipant = concurrentDatabase.withWorkspace(workspaceA, () =>
      Promise.reject(new Error('participant failed')),
    );

    try {
      await expect(failedParticipant).rejects.toThrow('participant failed');
    } finally {
      controller.abort();
      releaseBarrier();
      const outcomes = await Promise.allSettled([waiting, failedParticipant]);
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
      migrationHead: EXPECTED_MIGRATION_HEAD,
      postgresMajor: 18,
      role: 'pertexo_app',
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
