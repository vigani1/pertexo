import { createHash, randomUUID } from 'node:crypto';

import { count, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createWorkspaceDatabase } from '../src/database.js';
import {
  acceptWorkflowRun,
  IdempotencyRequestConflictError,
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
  it('commits one queued run, accepted event, revision-0 checkpoint, idempotency claim, and coordinator outbox', async () => {
    const accepted = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) => acceptWorkflowRun(transaction, acceptanceInput()),
    );

    expect(accepted).toMatchObject({ duplicate: false, status: 'queued' });
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      expect(
        await db
          .select({ count: count() })
          .from(idempotencyRecords)
          .where(eq(idempotencyRecords.resourceId, accepted.runId)),
      ).toEqual([{ count: 1 }]);
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
      ).toEqual([{ sequence: 1, type: 'run.accepted' }]);
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
        expect(row.canInsert).toBe(row.roleName === 'pertexo_api');
        expect(row.canUpdate).toBe(false);
        expect(row.canDelete).toBe(false);
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
