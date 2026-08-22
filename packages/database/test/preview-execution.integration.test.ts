import { createHash, randomUUID } from 'node:crypto';

import { count, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from '../src/config.js';
import { createWorkspaceDatabase } from '../src/database.js';
import { migrateDatabase } from '../src/migrations.js';
import {
  acceptPreviewRun,
  PreviewAdmissionDeniedError,
  PreviewIdempotencyConflictError,
  PriorPreviewInputUnavailableError,
  readPreviewRun,
} from '../src/preview-execution.js';
import {
  auditEvents,
  idempotencyRecords,
  outboxEvents,
  previewAttempts,
  previewRuns,
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
const actorId = randomUUID();
const workflowA = randomUUID();
const workflowB = randomUUID();
let releaseEpoch = 0;
let releaseFingerprint = '';
const keyHash = digest('preview-key');
const requestHash = digest('preview-request');
const otherRequestHash = digest('preview-request-conflict');
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

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function input(
  overrides: Partial<Parameters<typeof acceptPreviewRun>[1]> = {},
) {
  return {
    actorUserId: actorId,
    compatibilityReleaseEpoch: releaseEpoch,
    compatibilityReleaseFingerprint: releaseFingerprint,
    definitionKey: 'http.request',
    definitionVersion: 1,
    draftFingerprint: digest('draft-revision-1'),
    draftRevision: 1,
    dryRun: 'not_supported',
    executableNode: {
      schemaVersion: 1,
      id: 'http',
      config: { url: 'https://provider.example.test/resource' },
      connectionRefs: {},
    },
    executorKey: 'http.request',
    executorVersion: 1,
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    input: { kind: 'manual', value: { customerId: 'customer-1' } },
    keyHash,
    mayContactProvider: true,
    mayCauseExternalSideEffect: true,
    nodeId: 'http',
    operation: 'preview.execute',
    requestHash,
    requestId: 'request-preview-1',
    scope: `workflow:${workflowA}`,
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
    for (const [workspaceId, workflowId, workflowName] of [
      [workspaceA, workflowA, 'Workflow A'],
      [workspaceB, workflowB, 'Workflow B'],
    ] as const) {
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await client.query(
        `insert into app.workspace_memberships
         (workspace_id, user_id, role, status)
         values ($1, $2, 'builder', 'active')`,
        [workspaceId, actorId],
      );
      await client.query(
        `insert into app.workflows
       (id, workspace_id, name, created_by)
       values ($1, $2, $3, $4)`,
        [workflowId, workspaceId, workflowName, actorId],
      );
      await client.query(
        `insert into app.workflow_drafts
       (workflow_id, workspace_id, revision, schema_version, graph_json, updated_by)
       values ($1, $2, 1, 1, '{"schemaVersion":1,"nodes":[],"edges":[],"settings":{}}', $3)`,
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

beforeAll(async () => {
  await migrateDatabase(migrationConfig);
  const pool = new Pool({ connectionString: apiUrl, max: 1 });
  const result = await pool.query<{ epoch: number; fingerprint: string }>(
    'select epoch, fingerprint from app.node_compatibility_current where singleton = true',
  );
  await pool.end();
  const current = result.rows[0];
  if (current === undefined)
    throw new Error('Preview fixture requires a current compatibility release');
  releaseEpoch = current.epoch;
  releaseFingerprint = current.fingerprint;
});

beforeEach(resetFixture);

afterAll(async () => {
  await Promise.all([apiDatabase.close(), workerDatabase.close()]);
});

describe('durable preview acceptance', () => {
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
        compatibilityReleaseEpoch: releaseEpoch,
        actorUserId: actorId,
        idempotencyKeyHash: keyHash,
        requestHash,
        status: 'queued',
        priorPreviewRunId: null,
      });
      expect(runs[0]?.inputRef).toEqual({
        schemaVersion: 1,
        kind: 'inline',
        value: { customerId: 'customer-1' },
      });
      expect(await db.select({ count: count() }).from(previewAttempts)).toEqual(
        [{ count: 1 }],
      );
      expect(await db.select({ count: count() }).from(auditEvents)).toEqual([
        { count: 1 },
      ]);
      const jobs = await db.select().from(outboxEvents);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        id: accepted.outboxEventId,
        jobName: 'execute-preview-attempt',
        aggregateType: 'preview-run',
        aggregateId: accepted.previewRunId,
        payload: {
          schemaVersion: 1,
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
    const replayed = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) => acceptPreviewRun(transaction, input()),
    );
    expect(replayed).toEqual({ ...accepted, duplicate: true });
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptPreviewRun(transaction, input({ requestHash: otherRequestHash })),
      ),
    ).rejects.toBeInstanceOf(PreviewIdempotencyConflictError);
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

  it('copies only a successful unexpired prior output in the same workflow', async () => {
    const first = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptPreviewRun(transaction, input()),
    );
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.preview_attempts
       set status = 'succeeded', started_at = now(), completed_at = now(),
           output_ref = '{"schemaVersion":1,"kind":"inline","value":{"token":"persisted"}}'
       where id = $1`,
      [first.previewAttemptId],
    );
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.preview_runs
       set status = 'succeeded', started_at = now(), completed_at = now(),
           output_ref = '{"schemaVersion":1,"kind":"inline","value":{"token":"persisted"}}'
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
          schemaVersion: 1,
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

  it('reads only an unexpired tenant-scoped preview and its stored output', async () => {
    const accepted = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) => acceptPreviewRun(transaction, input()),
    );
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.preview_runs
       set status = 'succeeded', started_at = now(), completed_at = now(),
           output_ref = '{"schemaVersion":1,"kind":"inline","value":{"ok":true}}'
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

  it('gives the worker only scoped reads and execution-state updates', async () => {
    const accepted = await apiDatabase.withWorkspace(
      workspaceA,
      (transaction) => acceptPreviewRun(transaction, input()),
    );
    await workerDatabase.withWorkspace(workspaceA, async ({ db }) => {
      expect(await db.select().from(previewRuns)).toHaveLength(1);
      const grants = await db.execute<{
        canInsert: boolean;
        canUpdateProviderKey: boolean;
      }>(sql`
        select
          has_table_privilege(current_user, 'app.preview_attempts', 'INSERT') as "canInsert",
          has_column_privilege(
            current_user,
            'app.preview_attempts',
            'provider_idempotency_key',
            'UPDATE'
          ) as "canUpdateProviderKey"
      `);
      expect(grants.rows).toEqual([
        { canInsert: false, canUpdateProviderKey: false },
      ]);
      await expect(
        db.insert(previewAttempts).values({
          id: randomUUID(),
          workspaceId: workspaceA,
          previewRunId: accepted.previewRunId,
          status: 'queued',
          sideEffectClass: 'unsafe',
        }),
      ).rejects.toThrow();
      await expect(
        db
          .update(previewAttempts)
          .set({ providerIdempotencyKey: 'changed' })
          .where(eq(previewAttempts.id, accepted.previewAttemptId)),
      ).rejects.toThrow();
    });
  });
});
