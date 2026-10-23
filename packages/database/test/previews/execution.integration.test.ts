import { createHash, randomUUID } from 'node:crypto';

import { and, count, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createRetentionDatabase } from '../../src/lifecycle/retention.js';
import { createPreviewRetentionCoordinator } from '../../src/lifecycle/preview-retention.js';
import { parseDatabaseConfig } from '../../src/config.js';
import { createWorkspaceDatabase } from '../../src/database.js';
import { migrateDatabase } from '../../src/migrations.js';
import {
  acceptPreviewRun,
  PreviewAdmissionDeniedError,
  PreviewIdempotencyConflictError,
  PriorPreviewInputUnavailableError,
  readPreviewRun,
  resolvePreviewReplay,
} from '../../src/previews/repository.js';
import {
  auditEvents,
  idempotencyRecords,
  outboxEvents,
  previewAttempts,
  previewRuns,
  workspaceVariableSetRevisions,
} from '../../src/schema.js';
import { createDisposableDatabaseFixture } from '../support/postgres/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
const workerBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
const databaseName = `pertexo_test_preview_${randomUUID().replaceAll('-', '')}`;
const disposableDatabase = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
  databaseName,
  ownerRole: 'pertexo_owner',
});
const migrationUrl = disposableDatabase.databaseUrl(migrationBaseUrl);
const apiUrl = disposableDatabase.databaseUrl(apiBaseUrl);
const workerUrl = disposableDatabase.databaseUrl(workerBaseUrl);

const workspaceA = randomUUID();
const workspaceB = randomUUID();
const actorId = randomUUID();
const workflowA = randomUUID();
const workflowB = randomUUID();
const workflowC = randomUUID();
const keyHash = digest('preview-key');
const requestHash = digest('preview-request');
const otherRequestHash = digest('preview-request-conflict');
let apiDatabase!: ReturnType<typeof createWorkspaceDatabase>;
let workerDatabase!: ReturnType<typeof createWorkspaceDatabase>;
let databaseCreated = false;
const migrationConfig = {
  appRole: 'pertexo_app',
  connectionString: migrationUrl,
  maintenanceRole: 'pertexo_maintenance',
  ownerRole: 'pertexo_owner',
} as const;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function input(
  overrides: Partial<Parameters<typeof acceptPreviewRun>[1]> = {},
) {
  const now = Date.now();
  const expiresAt = overrides.expiresAt ?? new Date(now + 60 * 60 * 1_000);
  const executionDeadlineAt =
    overrides.executionDeadlineAt ??
    new Date(Math.min(now + 5 * 60 * 1_000, expiresAt.getTime()));
  return {
    actorUserId: actorId,
    definitionKey: 'http.request',
    definitionVersion: 1,
    draftFingerprint: digest('draft-revision-1'),
    draftRevision: 1,
    dryRun: 'not_supported',
    executableNode: {
      id: 'http',
      config: { url: 'https://provider.example.test/resource' },
      connectionRefs: {},
    },
    executorKey: 'http.request',
    executorVersion: 1,
    executionDeadlineAt,
    expiresAt,
    input: { kind: 'manual', value: { customerId: 'customer-1' } },
    keyHash,
    mayContactProvider: true,
    mayCauseExternalSideEffect: true,
    nodeId: 'http',
    operation: 'preview.execute',
    requestHash,
    requestId: 'request-preview-1',
    scope: `${actorId}:${workflowA}`,
    sideEffectClass: 'unsafe',
    traceId: 'trace-preview-1',
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    workflowId: workflowA,
    ...overrides,
  } as const;
}

async function ownerWorkspaceQuery(
  workspaceId: string,
  text: string,
  values: unknown[] = [],
): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    await client.query(text, values);
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function hasPostgresCode(error: unknown, code: string): boolean {
  let current = error;
  while (typeof current === 'object' && current !== null) {
    if ('code' in current && current.code === code) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

async function resetFixture(): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query(`truncate table
       app.preview_attempts, app.preview_runs, app.idempotency_records,
       app.outbox_events, app.audit_events, app.workflow_drafts,
       app.workflow_versions, app.workflows, app.workspace_memberships,
       app.workspaces, app.users
     cascade`);
    await client.query(
      `insert into app.users (id, email, display_name, status)
       values ($1, $2, 'Preview actor', 'active')`,
      [actorId, `preview-${actorId}@example.test`],
    );
    await client.query(
      `insert into app.workspaces (id, name, slug, status, created_by)
       values
         ($1, 'Preview A', $2, 'active', $5),
         ($3, 'Preview B', $4, 'active', $5)`,
      [
        workspaceA,
        `preview-a-${workspaceA}`,
        workspaceB,
        `preview-b-${workspaceB}`,
        actorId,
      ],
    );
    for (const workspaceId of [workspaceA, workspaceB]) {
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await client.query(
        `insert into app.workspace_memberships
         (workspace_id, user_id, role, status)
         values ($1, $2, 'builder', 'active')`,
        [workspaceId, actorId],
      );
    }
    for (const [workspaceId, workflowId, workflowName] of [
      [workspaceA, workflowA, 'Workflow A'],
      [workspaceA, workflowC, 'Workflow C'],
      [workspaceB, workflowB, 'Workflow B'],
    ] as const) {
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await client.query(
        `insert into app.workflows
       (id, workspace_id, name, created_by)
       values ($1, $2, $3, $4)`,
        [workflowId, workspaceId, workflowName, actorId],
      );
      await client.query(
        `insert into app.workflow_drafts
       (workflow_id, workspace_id, revision, graph_json, updated_by)
       values ($1, $2, 1, '{"nodes":[],"edges":[],"settings":{}}', $3)`,
        [workflowId, workspaceId, actorId],
      );
    }
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

beforeAll(beforeAllFixture1);

beforeEach(resetFixture);

afterAll(afterAllFixture2);

describe('durable preview acceptance', () => {
  registerCapturesVariablesOnPreviewAdmission();

  registerKeepsSimultaneousFirstRequestsBehind();

  registerCopiesSuccessfulUnexpiredPriorOutput();

  registerReadsUnexpiredTenantScopedPreview();
});

function registerCapturesVariablesOnPreviewAdmission(): void {
  it('captures variables on preview admission and preserves them for exact retries', async () => {
    await ownerWorkspaceQuery(
      workspaceA,
      `with revision as (insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json) values($1,1,'{"RATE":10}') returning workspace_id,revision)
       insert into app.workspace_variables(workspace_id,revision) select workspace_id,revision from revision`,
      [workspaceA],
    );
    const first = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptPreviewRun(transaction, input()),
    );
    await ownerWorkspaceQuery(
      workspaceA,
      `with revision as (insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json) values($1,2,'{"RATE":20}') returning workspace_id,revision)
       update app.workspace_variables head set revision=revision.revision from revision where head.workspace_id=revision.workspace_id`,
      [workspaceA],
    );
    const duplicate = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) => acceptPreviewRun(transaction, input()),
    );
    expect(duplicate.previewRunId).toBe(first.previewRunId);
    const next = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptPreviewRun(transaction, input({ keyHash: digest('new-preview') })),
    );
    const stored = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      transaction.db
        .select({
          id: previewRuns.id,
          revision: previewRuns.variableSetRevision,
          values: workspaceVariableSetRevisions.values,
        })
        .from(previewRuns)
        .leftJoin(
          workspaceVariableSetRevisions,
          and(
            eq(
              workspaceVariableSetRevisions.workspaceId,
              previewRuns.workspaceId,
            ),
            eq(
              workspaceVariableSetRevisions.revision,
              previewRuns.variableSetRevision,
            ),
          ),
        ),
    );
    expect(stored.find((row) => row.id === first.previewRunId)).toEqual({
      id: first.previewRunId,
      revision: 1,
      values: { RATE: 10 },
    });
    expect(stored.find((row) => row.id === next.previewRunId)).toEqual({
      id: next.previewRunId,
      revision: 2,
      values: { RATE: 20 },
    });
    const maintenanceConfig = parseDatabaseConfig({
      connectionString: disposableDatabase.databaseUrl(
        process.env.DATABASE_MAINTENANCE_URL ??
          'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
      ),
      max: 1,
    });
    const retention = createRetentionDatabase(maintenanceConfig);
    const previews = createPreviewRetentionCoordinator(maintenanceConfig, {
      delete: () => Promise.resolve(),
      head: () => Promise.resolve(null),
    });
    const revisions = () =>
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        transaction.db
          .select({ revision: workspaceVariableSetRevisions.revision })
          .from(workspaceVariableSetRevisions)
          .orderBy(workspaceVariableSetRevisions.revision),
      );
    try {
      await retention.enforce();
      expect(await revisions()).toEqual([{ revision: 1 }, { revision: 2 }]);
      await ownerWorkspaceQuery(
        workspaceA,
        `update app.preview_runs set status='failed',created_at=clock_timestamp()-interval '3 days',started_at=clock_timestamp()-interval '3 days'+interval '1 second',completed_at=clock_timestamp()-interval '3 days'+interval '2 seconds',execution_deadline_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' where id=$1`,
        [first.previewRunId],
      );
      expect(await previews.processNext()).toMatchObject({
        status: 'completed',
        previewRunId: first.previewRunId,
      });
      await retention.enforce();
      expect(await revisions()).toEqual([{ revision: 2 }]);
    } finally {
      await previews.close();
      await retention.close();
    }
  });

  it('atomically pins one preview, attempt, safe audit fact, and identifier-only job', async () => {
    const accepted = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) => acceptPreviewRun(transaction, input()),
    );
    expect(accepted).toMatchObject({ duplicate: false, status: 'queued' });

    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      const runs = await db.select().from(previewRuns);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        id: accepted.previewRunId,
        workflowId: workflowA,
        draftRevision: 1,
        definitionKey: 'http.request',
        executorKey: 'http.request',
        actorUserId: actorId,
        idempotencyKeyHash: keyHash,
        requestHash,
        status: 'queued',
        priorPreviewRunId: null,
      });
      expect(runs[0]?.inputRef).toEqual({
        kind: 'inline',
        value: { customerId: 'customer-1' },
      });
      expect(runs[0]?.executionDeadlineAt.getTime()).toBeLessThan(
        runs[0]?.expiresAt.getTime() ?? 0,
      );
      expect(await db.select({ count: count() }).from(previewAttempts)).toEqual(
        [{ count: 1 }],
      );
      expect(await db.select({ count: count() }).from(auditEvents)).toEqual([
        { count: 1 },
      ]);
      const jobs = await db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.jobName, 'execute-preview-attempt'));
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        id: accepted.outboxEventId,
        jobName: 'execute-preview-attempt',
        aggregateType: 'preview-run',
        aggregateId: accepted.previewRunId,
        payload: {
          workspaceId: workspaceA,
          outboxEventId: accepted.outboxEventId,
          previewRunId: accepted.previewRunId,
          previewAttemptId: accepted.previewAttemptId,
          traceparent:
            '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        },
      });
      expect(JSON.stringify(jobs[0]?.payload)).not.toContain(
        'provider.example',
      );
    });
  });

  it('returns the exact replay after a later draft edit and rejects a conflicting replay', async () => {
    const accepted = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) => acceptPreviewRun(transaction, input()),
    );
    await ownerWorkspaceQuery(
      workspaceA,
      'update app.workflow_drafts set revision = 2 where workflow_id = $1',
      [workflowA],
    );
    const resolved = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) =>
        resolvePreviewReplay(transaction, {
          actorUserId: actorId,
          workflowId: workflowA,
          keyHash,
          requestHash,
        }),
    );
    expect(resolved).toMatchObject({
      id: accepted.previewRunId,
      workflowId: workflowA,
      draftRevision: 1,
      nodeId: 'http',
      status: 'queued',
    });
    const replayed = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) => acceptPreviewRun(transaction, input()),
    );
    expect(replayed).toEqual({ ...accepted, duplicate: true });
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        resolvePreviewReplay(transaction, {
          actorUserId: actorId,
          workflowId: workflowA,
          keyHash,
          requestHash: otherRequestHash,
        }),
      ),
    ).rejects.toBeInstanceOf(PreviewIdempotencyConflictError);
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptPreviewRun(transaction, input({ requestHash: otherRequestHash })),
      ),
    ).rejects.toBeInstanceOf(PreviewIdempotencyConflictError);
  });
}

function registerKeepsSimultaneousFirstRequestsBehind(): void {
  it('keeps simultaneous first requests behind one atomic acceptance', async () => {
    const results = await Promise.all([
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptPreviewRun(transaction, input()),
      ),
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptPreviewRun(transaction, input()),
      ),
    ]);

    expect(results.map(({ duplicate }) => duplicate).sort()).toEqual([
      false,
      true,
    ]);
    expect(
      new Set(results.map(({ previewRunId }) => previewRunId)),
    ).toHaveProperty('size', 1);
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      expect(await db.select({ count: count() }).from(previewRuns)).toEqual([
        { count: 1 },
      ]);
      expect(await db.select({ count: count() }).from(previewAttempts)).toEqual(
        [{ count: 1 }],
      );
      expect(await db.select({ count: count() }).from(outboxEvents)).toEqual([
        { count: 1 },
      ]);
    });
  });

  it('denies revoked replay lookup and hides another workspace claim', async () => {
    await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptPreviewRun(transaction, input()),
    );
    await expect(
      apiDatabase.withWorkspace(workspaceB, (transaction) =>
        resolvePreviewReplay(transaction, {
          actorUserId: actorId,
          workflowId: workflowA,
          keyHash,
          requestHash,
        }),
      ),
    ).resolves.toBeNull();

    await ownerWorkspaceQuery(
      workspaceA,
      `update app.workspace_memberships set status = 'suspended'
       where workspace_id = $1 and user_id = $2`,
      [workspaceA, actorId],
    );
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        resolvePreviewReplay(transaction, {
          actorUserId: actorId,
          workflowId: workflowA,
          keyHash,
          requestHash,
        }),
      ),
    ).rejects.toBeInstanceOf(PreviewAdmissionDeniedError);
  });

  it('rolls every acceptance fact back with its caller transaction', async () => {
    await expect(
      apiDatabase.withWorkspace(workspaceA, async (transaction) => {
        await acceptPreviewRun(transaction, input());
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      for (const table of [
        previewRuns,
        previewAttempts,
        idempotencyRecords,
        outboxEvents,
        auditEvents,
      ] as const)
        expect(await db.select({ count: count() }).from(table)).toEqual([
          { count: 0 },
        ]);
    });
  });

  it('rejects stale draft and inactive builder admission before persistence', async () => {
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptPreviewRun(transaction, input({ draftRevision: 2 })),
      ),
    ).rejects.toBeInstanceOf(PreviewAdmissionDeniedError);
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.workspace_memberships set status = 'suspended'
       where workspace_id = $1 and user_id = $2`,
      [workspaceA, actorId],
    );
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptPreviewRun(transaction, input()),
      ),
    ).rejects.toBeInstanceOf(PreviewAdmissionDeniedError);
  });
}

function registerCopiesSuccessfulUnexpiredPriorOutput(): void {
  it('copies only a successful unexpired prior output in the same workflow', async () => {
    const first = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptPreviewRun(transaction, input()),
    );
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.preview_attempts
       set status = 'succeeded', started_at = now(), completed_at = now(),
           output_ref = to_jsonb(
             '{"kind":"inline","value":{"token":"persisted"}}'::text
           )
       where id = $1`,
      [first.previewAttemptId],
    );
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.preview_runs
       set status = 'succeeded', started_at = now(), completed_at = now(),
           output_ref = to_jsonb(
             '{"kind":"inline","value":{"token":"persisted"}}'::text
           )
       where id = $1`,
      [first.previewRunId],
    );
    const second = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptPreviewRun(
        transaction,
        input({
          input: { kind: 'prior_preview', previewRunId: first.previewRunId },
          keyHash: digest('second-key'),
          requestHash: digest('second-request'),
        }),
      ),
    );
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      const [row] = await db
        .select()
        .from(previewRuns)
        .where(eq(previewRuns.id, second.previewRunId));
      expect(row).toMatchObject({
        priorPreviewRunId: first.previewRunId,
        inputRef: {
          kind: 'inline',
          value: { token: 'persisted' },
        },
      });
    });

    await expect(
      apiDatabase.withWorkspace(workspaceB, (transaction) =>
        acceptPreviewRun(
          transaction,
          input({
            workflowId: workflowB,
            input: { kind: 'prior_preview', previewRunId: first.previewRunId },
            keyHash: digest('cross-key'),
            requestHash: digest('cross-request'),
            scope: `workflow:${workflowB}`,
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(PriorPreviewInputUnavailableError);

    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptPreviewRun(
          transaction,
          input({
            workflowId: workflowC,
            input: { kind: 'prior_preview', previewRunId: first.previewRunId },
            keyHash: digest('different-workflow-key'),
            requestHash: digest('different-workflow-request'),
            scope: `workflow:${workflowC}`,
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(PriorPreviewInputUnavailableError);

    const failed = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptPreviewRun(
        transaction,
        input({
          keyHash: digest('failed-source-key'),
          requestHash: digest('failed-source-request'),
        }),
      ),
    );
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.preview_attempts
          set status = 'failed', started_at = now(), completed_at = now(),
              safe_error_code = 'preview.fixture_failed'
        where id = $1`,
      [failed.previewAttemptId],
    );
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.preview_runs
          set status = 'failed', started_at = now(), completed_at = now(),
              safe_error_code = 'preview.fixture_failed'
        where id = $1`,
      [failed.previewRunId],
    );
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptPreviewRun(
          transaction,
          input({
            input: { kind: 'prior_preview', previewRunId: failed.previewRunId },
            keyHash: digest('failed-consumer-key'),
            requestHash: digest('failed-consumer-request'),
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(PriorPreviewInputUnavailableError);

    const expiring = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) =>
        acceptPreviewRun(
          transaction,
          input({
            expiresAt: new Date(Date.now() + 1_000),
            keyHash: digest('expiring-source-key'),
            requestHash: digest('expiring-source-request'),
          }),
        ),
    );
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.preview_attempts
          set status = 'succeeded', started_at = now(), completed_at = now(),
              output_ref = '{"kind":"inline","value":{"expired":true}}'
        where id = $1`,
      [expiring.previewAttemptId],
    );
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.preview_runs
          set status = 'succeeded', started_at = now(), completed_at = now(),
              output_ref = '{"kind":"inline","value":{"expired":true}}'
        where id = $1`,
      [expiring.previewRunId],
    );
    // Expiry is an immutable PostgreSQL acceptance fact, so this intentionally
    // crosses the database clock instead of mutating the protected identity.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptPreviewRun(
          transaction,
          input({
            input: {
              kind: 'prior_preview',
              previewRunId: expiring.previewRunId,
            },
            keyHash: digest('expired-consumer-key'),
            requestHash: digest('expired-consumer-request'),
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(PriorPreviewInputUnavailableError);
  });

  it('hides previews across workspaces and prevents API pin mutation', async () => {
    const accepted = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) => acceptPreviewRun(transaction, input()),
    );
    await apiDatabase.withWorkspace(workspaceB, async ({ db }) => {
      expect(await db.select().from(previewRuns)).toEqual([]);
      expect(await db.select().from(previewAttempts)).toEqual([]);
    });
    await expect(
      apiDatabase.withWorkspace(workspaceA, ({ db }) =>
        db
          .update(previewRuns)
          .set({ nodeId: 'changed' })
          .where(eq(previewRuns.id, accepted.previewRunId)),
      ),
    ).rejects.toSatisfy((error: unknown) => hasPostgresCode(error, '42501'));
  });
}

function registerReadsUnexpiredTenantScopedPreview(): void {
  it('reads only an unexpired tenant-scoped preview and its stored output', async () => {
    const accepted = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) => acceptPreviewRun(transaction, input()),
    );
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.preview_runs
       set status = 'succeeded', started_at = now(), completed_at = now(),
           output_ref = '{"kind":"inline","value":{"ok":true}}'
       where id = $1`,
      [accepted.previewRunId],
    );
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        readPreviewRun(transaction, {
          actorUserId: actorId,
          previewRunId: accepted.previewRunId,
        }),
      ),
    ).resolves.toMatchObject({
      id: accepted.previewRunId,
      status: 'succeeded',
      output: { kind: 'inline', value: { ok: true } },
    });
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.preview_runs
       set output_ref = to_jsonb(
         '{"kind":"inline","value":{"ok":true}}'::text
       )
       where id = $1`,
      [accepted.previewRunId],
    );
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        readPreviewRun(transaction, {
          actorUserId: actorId,
          previewRunId: accepted.previewRunId,
        }),
      ),
    ).resolves.toMatchObject({
      output: { kind: 'inline', value: { ok: true } },
    });
    await expect(
      apiDatabase.withWorkspace(workspaceB, (transaction) =>
        readPreviewRun(transaction, {
          actorUserId: actorId,
          previewRunId: accepted.previewRunId,
        }),
      ),
    ).resolves.toBeNull();

    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        readPreviewRun(
          transaction,
          {
            actorUserId: actorId,
            previewRunId: accepted.previewRunId,
          },
          accepted.expiresAt,
        ),
      ),
    ).resolves.toBeNull();
  });

  it('scopes preview reads and keeps the provider idempotency key fixed', async () => {
    const accepted = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) => acceptPreviewRun(transaction, input()),
    );
    const attemptId = accepted.previewAttemptId;
    if (attemptId === null)
      throw new Error('Fixture requires a real preview attempt');
    await workerDatabase.withWorkspace(workspaceA, async ({ db }) => {
      expect(await db.select().from(previewRuns)).toHaveLength(1);
    });
    await workerDatabase.withWorkspace(workspaceA, async ({ db }) => {
      await expect(
        db
          .update(previewAttempts)
          .set({ providerIdempotencyKey: 'changed' })
          .where(eq(previewAttempts.id, attemptId)),
      ).rejects.toThrow();
    });
  });
}

async function beforeAllFixture1() {
  await disposableDatabase.create();
  databaseCreated = true;
  try {
    await migrateDatabase(migrationConfig);
    apiDatabase = createWorkspaceDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
    );
    workerDatabase = createWorkspaceDatabase(
      parseDatabaseConfig({ connectionString: workerUrl, max: 2 }),
    );
  } catch (error: unknown) {
    await Promise.allSettled([apiDatabase.close(), workerDatabase.close()]);
    await disposableDatabase.drop();
    databaseCreated = false;
    throw error;
  }
}

async function afterAllFixture2() {
  const failures: unknown[] = [];
  for (const close of [
    () => apiDatabase.close(),
    () => workerDatabase.close(),
  ]) {
    try {
      await close();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (databaseCreated) {
    try {
      await disposableDatabase.drop();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, 'Preview fixture cleanup failed');
}
