import { createHash, randomUUID } from 'node:crypto';
import { count, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  acceptWorkflowRun,
  IDEMPOTENCY_STATUS_VALUES,
  RUN_STATUS_VALUES,
} from '../src/execution-acceptance.js';
import { checkDatabaseReadiness } from '../src/readiness.js';
import {
  idempotencyRecords,
  outboxEvents,
  runCheckpoints,
  runEvents,
  workflowRuns,
} from '../src/schema.js';
import {
  acceptanceInput,
  apiDatabase,
  apiUrl,
  hasPostgresCode,
  installExecutionAcceptanceFixture,
  keyHash,
  migrationUrl,
  requestHash,
  workspaceA,
  workspaceB,
  workflowId,
  workflowVersionId,
} from './execution-acceptance.fixtures.js';

installExecutionAcceptanceFixture();

describe('workflow run persistence security and compatibility', () => {
  it('hides all accepted state across workspaces and rejects a forged workspace insert', async () => {
    await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(transaction, acceptanceInput()),
    );

    await expect(
      apiDatabase.withWorkspace(workspaceB, async ({ db }) => {
        const tables = [
          idempotencyRecords,
          workflowRuns,
          runEvents,
          runCheckpoints,
          outboxEvents,
        ] as const;
        for (const table of tables) {
          expect(await db.select({ count: count() }).from(table)).toEqual([
            { count: 0 },
          ]);
        }
        await db.insert(workflowRuns).values({
          id: randomUUID(),
          workspaceId: workspaceA,
          workflowId,
          workflowVersionId,
          triggerType: 'manual',
          status: 'queued',
        });
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        hasPostgresCode('42501')(error) || hasPostgresCode('PTA01')(error),
    );
  });

  it('accepts canonical execution statuses and rejects legacy spellings', async () => {
    const runtime = new Pool({ connectionString: apiUrl, max: 1 });
    const client = await runtime.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.workspace_id', $1, true)`, [
        workspaceA,
      ]);

      for (const status of RUN_STATUS_VALUES) {
        await client.query(
          `
            insert into app.workflow_runs (
              id, workspace_id, workflow_id, workflow_version_id,
              trigger_type, status
            ) values ($1, $2, $3, $4, 'manual', $5)
          `,
          [randomUUID(), workspaceA, workflowId, workflowVersionId, status],
        );
      }

      await client.query('savepoint reject_legacy_run_status');
      await expect(
        client.query(
          `
            insert into app.workflow_runs (
              id, workspace_id, workflow_id, workflow_version_id,
              trigger_type, status
            ) values ($1, $2, $3, $4, 'manual', 'cancelled')
          `,
          [randomUUID(), workspaceA, workflowId, workflowVersionId],
        ),
      ).rejects.toSatisfy(hasPostgresCode('23514'));
      await client.query('rollback to savepoint reject_legacy_run_status');

      for (const status of IDEMPOTENCY_STATUS_VALUES) {
        await client.query(
          `
            insert into app.idempotency_records (
              id, workspace_id, operation, scope, key_hash, request_hash,
              status, resource_id, result_ref
            ) values ($1, $2, 'workflow.run.accept', $3, $4, $5, $6, $7, '{}')
          `,
          [
            randomUUID(),
            workspaceA,
            `status:${status}`,
            createHash('sha256').update(`key:${status}`).digest('hex'),
            createHash('sha256').update(`request:${status}`).digest('hex'),
            status,
            randomUUID(),
          ],
        );
      }

      await client.query('savepoint reject_legacy_idempotency_status');
      await expect(
        client.query(
          `
            insert into app.idempotency_records (
              id, workspace_id, operation, scope, key_hash, request_hash,
              status, resource_id, result_ref
            ) values ($1, $2, 'workflow.run.accept', 'legacy-status', $3, $4,
              'claimed', $5, '{}')
          `,
          [randomUUID(), workspaceA, keyHash, requestHash, randomUUID()],
        ),
      ).rejects.toSatisfy(hasPostgresCode('23514'));
      await client.query(
        'rollback to savepoint reject_legacy_idempotency_status',
      );
      await client.query('rollback');
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
      await runtime.end();
    }
  });

  it('forces RLS and grants only the acceptance operations to runtime roles', async () => {
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      const security = await owner.query<{
        relforcerowsecurity: boolean;
        relrowsecurity: boolean;
        relname: string;
      }>(
        `
        select c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app'
          and c.relname = any($1::text[])
        order by c.relname
      `,
        [
          [
            'idempotency_records',
            'run_checkpoints',
            'run_events',
            'workflow_runs',
          ],
        ],
      );
      expect(security.rows).toHaveLength(4);
      expect(
        security.rows.every(
          (row) => row.relrowsecurity && row.relforcerowsecurity,
        ),
      ).toBe(true);

      const privileges = await owner.query<{
        canDelete: boolean;
        canInsert: boolean;
        canSelect: boolean;
        canUpdate: boolean;
        roleName: string;
        tableName: string;
      }>(`
        with runtime_roles(role_name) as (
          values ('pertexo_api'), ('pertexo_dispatcher'), ('pertexo_worker')
        ), execution_tables(table_oid, table_name) as (
          select c.oid, c.relname
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'app'
            and c.relname = any(array[
              'idempotency_records',
              'run_checkpoints',
              'run_events',
              'workflow_runs'
            ])
        )
        select
          role_name as "roleName",
          table_name as "tableName",
          has_table_privilege(role_name, table_oid, 'SELECT') as "canSelect",
          has_table_privilege(role_name, table_oid, 'INSERT') as "canInsert",
          has_table_privilege(role_name, table_oid, 'UPDATE') as "canUpdate",
          has_table_privilege(role_name, table_oid, 'DELETE') as "canDelete"
        from runtime_roles
        cross join execution_tables
        order by role_name, table_name
      `);
      expect(privileges.rows).toHaveLength(12);
      for (const row of privileges.rows) {
        expect(row.canSelect).toBe(row.roleName !== 'pertexo_dispatcher');
        expect(row.canInsert).toBe(
          row.roleName === 'pertexo_api' || row.roleName === 'pertexo_worker',
        );
        expect(row.canUpdate).toBe(false);
        expect(row.canDelete).toBe(false);
      }

      const idempotencyUpdatePrivileges = await owner.query<{
        canUpdate: boolean;
        columnName: string;
        roleName: string;
      }>(`
        with runtime_roles(role_name) as (
          values ('pertexo_api'), ('pertexo_dispatcher'), ('pertexo_worker')
        ), idempotency_columns(column_name) as (
          values
            ('status'),
            ('result_ref'),
            ('updated_at'),
            ('request_hash'),
            ('resource_id')
        ), idempotency_relation(oid) as (
          select table_class.oid
          from pg_class table_class
          join pg_namespace table_namespace
            on table_namespace.oid = table_class.relnamespace
          where table_namespace.nspname = 'app'
            and table_class.relname = 'idempotency_records'
        )
        select
          role_name as "roleName",
          column_name as "columnName",
          has_column_privilege(
            role_name,
            idempotency_relation.oid,
            column_name,
            'UPDATE'
          ) as "canUpdate"
        from runtime_roles
        cross join idempotency_columns
        cross join idempotency_relation
        order by role_name, column_name
      `);
      expect(idempotencyUpdatePrivileges.rows).toHaveLength(15);
      for (const row of idempotencyUpdatePrivileges.rows) {
        expect(row.canUpdate).toBe(
          (row.roleName === 'pertexo_api' ||
            row.roleName === 'pertexo_worker') &&
            ['result_ref', 'status', 'updated_at'].includes(row.columnName),
        );
      }
    } finally {
      await owner.end();
    }
  });

  it('forces entitlement RLS and denies serving-role entitlement mutation', async () => {
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      const catalog = await owner.query<{
        relforcerowsecurity: boolean;
        relname: string;
        relrowsecurity: boolean;
      }>(`
        select relname,relrowsecurity,relforcerowsecurity
          from pg_class where oid=any(array[
            'app.workspace_execution_entitlement_versions'::regclass,
            'app.workspace_execution_entitlements'::regclass,
            'app.workspace_execution_admission_counters'::regclass
          ]) order by relname
      `);
      expect(catalog.rows).toHaveLength(3);
      expect(
        catalog.rows.every(
          ({ relrowsecurity, relforcerowsecurity }) =>
            relrowsecurity && relforcerowsecurity,
        ),
      ).toBe(true);
      const grants = await owner.query<{
        can_insert: boolean;
        can_select: boolean;
        can_update: boolean;
        role_name: string;
      }>(`
        with roles(role_name) as (
          values ('pertexo_api'),('pertexo_worker'),('pertexo_dispatcher')
        ) select role_name,
          has_table_privilege(role_name,'app.workspace_execution_entitlement_versions','SELECT') can_select,
          has_table_privilege(role_name,'app.workspace_execution_entitlement_versions','INSERT') can_insert,
          has_table_privilege(role_name,'app.workspace_execution_entitlement_versions','UPDATE') can_update
        from roles order by role_name
      `);
      expect(grants.rows).toEqual([
        {
          role_name: 'pertexo_api',
          can_select: true,
          can_insert: false,
          can_update: false,
        },
        {
          role_name: 'pertexo_dispatcher',
          can_select: false,
          can_insert: false,
          can_update: false,
        },
        {
          role_name: 'pertexo_worker',
          can_select: true,
          can_insert: false,
          can_update: false,
        },
      ]);
      await owner.query('commit');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.end();
    }
    await expect(
      apiDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.execute(sql`
          update app.workspace_execution_entitlement_versions
             set queued_run_limit=101 where workspace_id=${workspaceA} and version=1
        `),
      ),
    ).rejects.toSatisfy(hasPostgresCode('42501'));
  });

  it('fails readiness when an admission trigger is disabled', async () => {
    const readiness = new Pool({ connectionString: apiUrl, max: 1 });
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      await expect(
        checkDatabaseReadiness(readiness, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).resolves.toBeDefined();
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query(
        'alter table app.workflow_runs disable trigger workflow_runs_execution_admission',
      );
      await owner.query('commit');
      await expect(
        checkDatabaseReadiness(readiness, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).rejects.toThrow('Execution admission persistence is incompatible');
    } finally {
      await owner.query('rollback').catch(() => undefined);
      await owner.query('begin').catch(() => undefined);
      await owner.query('set local role pertexo_owner').catch(() => undefined);
      await owner
        .query(
          'alter table app.workflow_runs enable trigger workflow_runs_execution_admission',
        )
        .catch(() => undefined);
      await owner.query('commit').catch(() => undefined);
      await Promise.all([owner.end(), readiness.end()]);
    }
  });
});
