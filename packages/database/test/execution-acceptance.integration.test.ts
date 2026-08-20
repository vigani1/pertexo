import { createHash, randomUUID } from 'node:crypto';

import { count, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createWorkspaceDatabase } from '../src/database.js';
import {
  acceptWorkflowRun,
  IDEMPOTENCY_STATUS_VALUES,
  IdempotencyRequestConflictError,
  RUN_STATUS_VALUES,
  WorkspaceRunAdmissionDeniedError,
} from '../src/execution-acceptance.js';
import { migrateDatabase } from '../src/migrations.js';
import {
  idempotencyRecords,
  outboxEvents,
  runCheckpoints,
  runEvents,
  workflowRuns,
} from '../src/schema.js';

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
const workflowId = randomUUID();
const workflowVersionId = randomUUID();
const keyHash = createHash('sha256').update('acceptance-key').digest('hex');
const requestHash = createHash('sha256').update('request-a').digest('hex');
const otherRequestHash = createHash('sha256').update('request-b').digest('hex');
const workspaceCreatorId = randomUUID();

const apiDatabase = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
);
const workerDatabase = createWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: workerUrl, max: 2 }),
);

const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: migrationUrl,
  dispatcherRole: 'pertexo_dispatcher',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

function hasPostgresCode(expectedCode: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    let current = error;
    while (current instanceof Error) {
      if ('code' in current && current.code === expectedCode) return true;
      current = current.cause;
    }
    return false;
  };
}

function acceptanceInput(requestHashOverride = requestHash) {
  return {
    engineVersion: 'phase0-engine-v1',
    keyHash,
    operation: 'workflow.run.accept',
    requestHash: requestHashOverride,
    scope: `workflow:${workflowId}:manual`,
    triggerType: 'manual',
    workflowId,
    workflowVersionId,
  } as const;
}

async function expectAcceptanceRecordCounts(expected: number): Promise<void> {
  await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
    const tables = [
      idempotencyRecords,
      workflowRuns,
      runEvents,
      runCheckpoints,
      outboxEvents,
    ] as const;
    for (const table of tables) {
      expect(await db.select({ count: count() }).from(table)).toEqual([
        { count: expected },
      ]);
    }
  });
}

async function resetExecutionFixture(): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query(`
      truncate table
        app.idempotency_records,
        app.run_events,
        app.run_checkpoints,
        app.workflow_runs,
        app.outbox_events
      cascade
    `);
    await client.query(
      `insert into app.users (id, email, display_name, status)
       values ($1, $2, 'Execution fixture owner', 'active')
       on conflict (id) do update set status = 'active'`,
      [workspaceCreatorId, `execution-${workspaceCreatorId}@example.test`],
    );
    await client.query(
      `insert into app.workspaces (id, name, slug, status, created_by)
       values
         ($1, 'Execution A', $3, 'active', $5),
         ($2, 'Execution B', $4, 'active', $5)
       on conflict (id) do update set
         status = 'active',
         deletion_requested_at = null,
         deletion_requested_by = null,
         deletion_reason = null,
         purge_after = null`,
      [
        workspaceA,
        workspaceB,
        `execution-a-${workspaceA}`,
        `execution-b-${workspaceB}`,
        workspaceCreatorId,
      ],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

beforeAll(async () => {
  await migrateDatabase(migrationConfig);
});

beforeEach(resetExecutionFixture);

afterAll(async () => {
  await Promise.all([apiDatabase.close(), workerDatabase.close()]);
});

describe('atomic workflow run acceptance', () => {
  it.each(['suspended', 'pending_deletion', 'deleted'] as const)(
    'rejects new runs while the workspace is %s without persisting acceptance state',
    async (status) => {
      const owner = new Pool({ connectionString: migrationUrl, max: 1 });
      const client = await owner.connect();
      try {
        await client.query('begin');
        await client.query('set local role pertexo_owner');
        await client.query(
          `update app.workspaces
           set status = $2::varchar,
               deletion_requested_at = case when $2::text = 'suspended' then null else now() end,
               deletion_requested_by = case when $2::text = 'suspended' then null::uuid else $3::uuid end,
               deletion_reason = case when $2::text = 'suspended' then null::varchar else 'fixture deletion'::varchar end,
               purge_after = case when $2::text = 'suspended' then null else now() + interval '30 days' end
           where id = $1`,
          [workspaceA, status, workspaceCreatorId],
        );
        await client.query('commit');
      } catch (error: unknown) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
        await owner.end();
      }

      await expect(
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(transaction, acceptanceInput()),
        ),
      ).rejects.toBeInstanceOf(WorkspaceRunAdmissionDeniedError);
      await expectAcceptanceRecordCounts(0);
    },
  );

  it('fails closed when the workspace lifecycle row does not exist', async () => {
    await expect(
      apiDatabase.withWorkspace(randomUUID(), (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      ),
    ).rejects.toBeInstanceOf(WorkspaceRunAdmissionDeniedError);
    await expectAcceptanceRecordCounts(0);
  });

  it('waits for an in-flight deletion and rejects after deletion wins the row lock', async () => {
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    const deletion = await owner.connect();
    try {
      await deletion.query('begin');
      await deletion.query('set local role pertexo_owner');
      await deletion.query(
        `update app.workspaces
         set status = 'pending_deletion',
             deletion_requested_at = now(),
             deletion_requested_by = $2,
             deletion_reason = 'concurrent deletion',
             purge_after = now() + interval '30 days'
         where id = $1`,
        [workspaceA, workspaceCreatorId],
      );

      const admission = apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      );
      const stateBeforeCommit = await Promise.race([
        admission.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<'waiting'>((resolve) => {
          setTimeout(() => {
            resolve('waiting');
          }, 50);
        }),
      ]);
      expect(stateBeforeCommit).toBe('waiting');

      await deletion.query('commit');
      await expect(admission).rejects.toBeInstanceOf(
        WorkspaceRunAdmissionDeniedError,
      );
      await expectAcceptanceRecordCounts(0);
    } catch (error: unknown) {
      await deletion.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      deletion.release();
      await owner.end();
    }
  });

  it('lets an admitted run commit before a racing deletion takes effect', async () => {
    let releaseAdmission!: () => void;
    const holdAdmission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let acceptanceLocked!: () => void;
    const admissionLocked = new Promise<void>((resolve) => {
      acceptanceLocked = resolve;
    });

    const admission = apiDatabase.withWorkspace(
      workspaceA,
      async (transaction) => {
        const accepted = await acceptWorkflowRun(
          transaction,
          acceptanceInput(),
        );
        acceptanceLocked();
        await holdAdmission;
        return accepted;
      },
    );
    await admissionLocked;

    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    const deletionClient = await owner.connect();
    await deletionClient.query('begin');
    await deletionClient.query('set local role pertexo_owner');
    const deletion = deletionClient.query(
      `update app.workspaces
       set status = 'pending_deletion',
           deletion_requested_at = now(),
           deletion_requested_by = $2,
           deletion_reason = 'concurrent deletion',
           purge_after = now() + interval '30 days'
       where id = $1
       returning status`,
      [workspaceA, workspaceCreatorId],
    );
    try {
      const stateBeforeAdmissionCommit = await Promise.race([
        deletion.then(() => 'settled'),
        new Promise<'waiting'>((resolve) => {
          setTimeout(() => {
            resolve('waiting');
          }, 50);
        }),
      ]);
      expect(stateBeforeAdmissionCommit).toBe('waiting');

      releaseAdmission();
      await expect(admission).resolves.toMatchObject({
        duplicate: false,
        status: 'queued',
      });
      await expect(deletion).resolves.toMatchObject({
        rows: [{ status: 'pending_deletion' }],
      });
      await deletionClient.query('commit');
      await expectAcceptanceRecordCounts(1);
    } finally {
      releaseAdmission();
      await Promise.allSettled([admission, deletion]);
      await deletionClient.query('rollback').catch(() => undefined);
      deletionClient.release();
      await owner.end();
    }
  });

  it('commits one queued run, accepted event, revision-0 checkpoint, idempotency claim, and coordinator outbox', async () => {
    const accepted = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) => acceptWorkflowRun(transaction, acceptanceInput()),
    );

    expect(accepted).toMatchObject({ duplicate: false, status: 'queued' });
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      expect(
        await db
          .select({ status: idempotencyRecords.status })
          .from(idempotencyRecords)
          .where(eq(idempotencyRecords.resourceId, accepted.runId)),
      ).toEqual([{ status: 'completed' }]);
      expect(
        await db
          .select({ status: workflowRuns.status })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, accepted.runId)),
      ).toEqual([{ status: 'queued' }]);
      expect(
        await db
          .select({ sequence: runEvents.sequence, type: runEvents.type })
          .from(runEvents)
          .where(eq(runEvents.workflowRunId, accepted.runId)),
      ).toEqual([{ sequence: 1, type: 'run.queued' }]);
      expect(
        await db
          .select({ revision: runCheckpoints.revision })
          .from(runCheckpoints)
          .where(eq(runCheckpoints.workflowRunId, accepted.runId)),
      ).toEqual([{ revision: 0 }]);
      expect(
        await db
          .select({
            aggregateId: outboxEvents.aggregateId,
            jobName: outboxEvents.jobName,
            payload: outboxEvents.payload,
          })
          .from(outboxEvents)
          .where(eq(outboxEvents.aggregateId, accepted.runId)),
      ).toEqual([
        {
          aggregateId: accepted.runId,
          jobName: 'advance-workflow-run',
          payload: {
            outboxEventId: accepted.outboxEventId,
            runId: accepted.runId,
            schemaVersion: 1,
            workspaceId: workspaceA,
          },
        },
      ]);
    });
  });

  it('returns the existing run for an exact retry and rejects a changed request hash', async () => {
    const first = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(transaction, acceptanceInput()),
    );
    const retry = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(transaction, acceptanceInput()),
    );

    expect(retry).toEqual({ ...first, duplicate: true });
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput(otherRequestHash)),
      ),
    ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
    await expectAcceptanceRecordCounts(1);
  });

  it.each(['suspended', 'pending_deletion', 'deleted'] as const)(
    'returns durable accepted truth for an exact retry after the workspace becomes %s',
    async (status) => {
      const first = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      );
      const owner = new Pool({ connectionString: migrationUrl, max: 1 });
      try {
        await owner.query('set role pertexo_owner');
        await owner.query(
          `update app.workspaces
           set status = $2::varchar,
               deletion_requested_at = case when $2::text = 'suspended' then null else now() end,
               deletion_requested_by = case when $2::text = 'suspended' then null::uuid else $3::uuid end,
               deletion_reason = case when $2::text = 'suspended' then null::varchar else 'fixture deletion'::varchar end,
               purge_after = case when $2::text = 'suspended' then null else now() + interval '30 days' end
           where id = $1`,
          [workspaceA, status, workspaceCreatorId],
        );
      } finally {
        await owner.end();
      }

      await expect(
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(transaction, acceptanceInput()),
        ),
      ).resolves.toEqual({ ...first, duplicate: true });
      await expect(
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(transaction, acceptanceInput(otherRequestHash)),
        ),
      ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
      await expectAcceptanceRecordCounts(1);
    },
  );

  it('rolls the entire acceptance back when its surrounding transaction fails', async () => {
    await expect(
      apiDatabase.withWorkspace(workspaceA, async (transaction) => {
        await acceptWorkflowRun(transaction, acceptanceInput());
        throw new Error('injected post-acceptance failure');
      }),
    ).rejects.toThrow('injected post-acceptance failure');

    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
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
    });
  });

  it('serializes concurrent exact retries to one accepted run', async () => {
    const [left, right] = await Promise.all([
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      ),
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      ),
    ]);

    expect(left.runId).toBe(right.runId);
    expect([left.duplicate, right.duplicate].sort()).toEqual([false, true]);
    await expectAcceptanceRecordCounts(1);
  });

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
    ).rejects.toSatisfy(hasPostgresCode('42501'));
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
          row.roleName === 'pertexo_api' ||
            (row.roleName === 'pertexo_worker' &&
              row.tableName === 'run_events'),
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
          row.roleName === 'pertexo_api' &&
            ['result_ref', 'status', 'updated_at'].includes(row.columnName),
        );
      }
    } finally {
      await owner.end();
    }

    await expect(
      workerDatabase.withWorkspace(workspaceA, ({ db }) =>
        db.insert(workflowRuns).values({
          id: randomUUID(),
          workspaceId: workspaceA,
          workflowId,
          workflowVersionId,
          triggerType: 'manual',
          status: 'queued',
        }),
      ),
    ).rejects.toSatisfy(hasPostgresCode('42501'));
  });
});
