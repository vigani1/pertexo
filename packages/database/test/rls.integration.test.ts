import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import type { DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createWorkspaceDatabase } from '../src/database.js';
import { migrateDatabase } from '../src/migrations.js';
import { rlsProbeRecords } from '../src/schema.js';

const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';

const workspaceA = randomUUID();
const workspaceB = randomUUID();
const recordA = randomUUID();
const recordB = randomUUID();

const database = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
);

function expectPgCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    let current: unknown = error;
    while (current instanceof Error) {
      if ((current as DatabaseError).code === code) {
        return true;
      }
      current = current.cause;
    }
    return false;
  };
}

beforeAll(async () => {
  await migrateDatabase({
    connectionString: migrationUrl,
    ownerRole: 'pertexo_owner',
  });
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
});

afterAll(async () => {
  await database.close();
});

describe('workspace transaction boundary', () => {
  it('keeps reviewed migrations idempotent after reaching head', async () => {
    await expect(
      migrateDatabase({
        connectionString: migrationUrl,
        ownerRole: 'pertexo_owner',
      }),
    ).resolves.toEqual([]);
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

describe('database readiness', () => {
  it('verifies migration, PostgreSQL, ownership, RLS, and runtime role compatibility', async () => {
    await expect(database.checkReadiness()).resolves.toEqual({
      migrationHead: '0000_rls_probe.sql',
      postgresMajor: 18,
      role: 'pertexo_api',
    });
  });
});
