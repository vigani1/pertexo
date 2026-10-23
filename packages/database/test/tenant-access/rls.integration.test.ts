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
} from './rls/fixture.js';
import { registerKeepsReviewedMigrationsIdempotentAfter } from './rls/keeps-reviewed-migrations-idempotent-after.cases.js';
import { registerClearsTransactionLocalContextBefore } from './rls/clears-transaction-local-context-before.cases.js';
import { registerVerifiesBoundedSteadyStateMigration } from './rls/verifies-bounded-steady-state-migration.cases.js';
beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);
describe('workspace transaction boundary', () => {
  registerKeepsReviewedMigrationsIdempotentAfter();

  registerClearsTransactionLocalContextBefore();
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
  registerVerifiesBoundedSteadyStateMigration();
});
