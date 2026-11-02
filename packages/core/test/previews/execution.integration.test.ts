import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  resetFixture,
  beforeAllFixture1,
  afterAllFixture2,
  disposableDatabase,
  workspaceA,
  actorId,
  workflowA,
  keyHash,
  requestHash,
  otherRequestHash,
  apiDatabase,
  digest,
  input,
  ownerWorkspaceQuery,
  apiPreviews,
  workspaceB,
  workflowB,
  workflowC,
  hasPostgresCode,
  workerDatabase,
} from './execution/fixture.js';
import { and, count, eq } from 'drizzle-orm';
import { createRetentionStore } from '../../src/lifecycle/retention/store.js';
import { createPreviewRetentionCoordinator } from '../../src/lifecycle/previews/coordinator.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  PreviewIdempotencyConflictError,
  PreviewAdmissionDeniedError,
  PriorPreviewInputUnavailableError,
} from '../../src/previews/errors.js';
import {
  auditEvents,
  outboxEvents,
  previewAttempts,
  previewRuns,
  workspaceVariableSetRevisions,
  idempotencyRecords,
} from '@pertexo/database/schema';
import { acceptPreviewRun } from '../../src/previews/runs/accept.js';
import { readPreviewRun } from '../../src/previews/runs/records.queries.js';

// Previews are kept at most seven days and execute for at most five minutes.
const minute = 60 * 1_000;

const sevenDays = 7 * 24 * 60 * minute;

const fiveMinutes = 5 * minute;

beforeAll(beforeAllFixture1);
beforeEach(resetFixture);
afterAll(afterAllFixture2);
describe('durable preview acceptance', () => {
  it('captures variables on preview admission and preserves them for exact retries', async () => {
    await ownerWorkspaceQuery(
      workspaceA,
      `with revision as (insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json) values($1,1,'{"RATE":10}') returning workspace_id,revision)
       insert into app.workspace_variables(workspace_id,revision) select workspace_id,revision from revision`,
      [workspaceA],
    );
    const first = await apiPreviews.acceptPreview({
      workspaceId: workspaceA,
      ...input(),
    });
    await ownerWorkspaceQuery(
      workspaceA,
      `with revision as (insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json) values($1,2,'{"RATE":20}') returning workspace_id,revision)
       update app.workspace_variables head set revision=revision.revision from revision where head.workspace_id=revision.workspace_id`,
      [workspaceA],
    );
    const duplicate = await apiPreviews.acceptPreview({
      workspaceId: workspaceA,
      ...input(),
    });
    expect(duplicate.previewRunId).toBe(first.previewRunId);
    const next = await apiPreviews.acceptPreview({
      workspaceId: workspaceA,
      ...input({ keyHash: digest('new-preview') }),
    });
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
    const retention = createRetentionStore(maintenanceConfig);
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
    const accepted = await apiPreviews.acceptPreview({
      workspaceId: workspaceA,
      ...input(),
    });
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
    const accepted = await apiPreviews.acceptPreview({
      workspaceId: workspaceA,
      ...input(),
    });
    await ownerWorkspaceQuery(
      workspaceA,
      'update app.workflow_drafts set revision = 2 where workflow_id = $1',
      [workflowA],
    );
    const resolved = await apiPreviews.resolvePreviewReplay({
      workspaceId: workspaceA,
      actorUserId: actorId,
      workflowId: workflowA,
      keyHash,
      requestHash,
    });
    expect(resolved).toMatchObject({
      id: accepted.previewRunId,
      workflowId: workflowA,
      draftRevision: 1,
      nodeId: 'http',
      status: 'queued',
    });
    const replayed = await apiPreviews.acceptPreview({
      workspaceId: workspaceA,
      ...input(),
    });
    expect(replayed).toEqual({ ...accepted, duplicate: true });
    await expect(
      apiPreviews.resolvePreviewReplay({
        workspaceId: workspaceA,
        actorUserId: actorId,
        workflowId: workflowA,
        keyHash,
        requestHash: otherRequestHash,
      }),
    ).rejects.toBeInstanceOf(PreviewIdempotencyConflictError);
    await expect(
      apiPreviews.acceptPreview({
        workspaceId: workspaceA,
        ...input({ requestHash: otherRequestHash }),
      }),
    ).rejects.toBeInstanceOf(PreviewIdempotencyConflictError);
  });

  it('keeps simultaneous first requests behind one atomic acceptance', async () => {
    const results = await Promise.all([
      apiPreviews.acceptPreview({ workspaceId: workspaceA, ...input() }),
      apiPreviews.acceptPreview({ workspaceId: workspaceA, ...input() }),
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
    await apiPreviews.acceptPreview({ workspaceId: workspaceA, ...input() });
    await expect(
      apiPreviews.resolvePreviewReplay({
        workspaceId: workspaceB,
        actorUserId: actorId,
        workflowId: workflowA,
        keyHash,
        requestHash,
      }),
    ).resolves.toBeNull();

    await ownerWorkspaceQuery(
      workspaceA,
      `update app.workspace_memberships set status = 'suspended'
       where workspace_id = $1 and user_id = $2`,
      [workspaceA, actorId],
    );
    await expect(
      apiPreviews.resolvePreviewReplay({
        workspaceId: workspaceA,
        actorUserId: actorId,
        workflowId: workflowA,
        keyHash,
        requestHash,
      }),
    ).rejects.toBeInstanceOf(PreviewAdmissionDeniedError);
  });

  it('rolls every acceptance fact back with its caller transaction', async () => {
    await expect(
      apiDatabase.withWorkspace(workspaceA, async (transaction) => {
        await acceptPreviewRun(transaction, input(), 'builder');
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
      apiPreviews.acceptPreview({
        workspaceId: workspaceA,
        ...input({ draftRevision: 2 }),
      }),
    ).rejects.toBeInstanceOf(PreviewAdmissionDeniedError);
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.workspace_memberships set status = 'suspended'
       where workspace_id = $1 and user_id = $2`,
      [workspaceA, actorId],
    );
    await expect(
      apiPreviews.acceptPreview({ workspaceId: workspaceA, ...input() }),
    ).rejects.toBeInstanceOf(PreviewAdmissionDeniedError);
  });

  it('copies only a successful unexpired prior output in the same workflow', async () => {
    const first = await apiPreviews.acceptPreview({
      workspaceId: workspaceA,
      ...input(),
    });
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
    const second = await apiPreviews.acceptPreview({
      workspaceId: workspaceA,
      ...input({
        input: { kind: 'prior_preview', previewRunId: first.previewRunId },
        keyHash: digest('second-key'),
        requestHash: digest('second-request'),
      }),
    });
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
      apiPreviews.acceptPreview({
        workspaceId: workspaceB,
        ...input({
          workflowId: workflowB,
          input: { kind: 'prior_preview', previewRunId: first.previewRunId },
          keyHash: digest('cross-key'),
          requestHash: digest('cross-request'),
          scope: `workflow:${workflowB}`,
        }),
      }),
    ).rejects.toBeInstanceOf(PriorPreviewInputUnavailableError);

    await expect(
      apiPreviews.acceptPreview({
        workspaceId: workspaceA,
        ...input({
          workflowId: workflowC,
          input: { kind: 'prior_preview', previewRunId: first.previewRunId },
          keyHash: digest('different-workflow-key'),
          requestHash: digest('different-workflow-request'),
          scope: `workflow:${workflowC}`,
        }),
      }),
    ).rejects.toBeInstanceOf(PriorPreviewInputUnavailableError);

    const failed = await apiPreviews.acceptPreview({
      workspaceId: workspaceA,
      ...input({
        keyHash: digest('failed-source-key'),
        requestHash: digest('failed-source-request'),
      }),
    });
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
      apiPreviews.acceptPreview({
        workspaceId: workspaceA,
        ...input({
          input: { kind: 'prior_preview', previewRunId: failed.previewRunId },
          keyHash: digest('failed-consumer-key'),
          requestHash: digest('failed-consumer-request'),
        }),
      }),
    ).rejects.toBeInstanceOf(PriorPreviewInputUnavailableError);

    const expiring = await apiPreviews.acceptPreview({
      workspaceId: workspaceA,
      ...input({
        expiresAt: new Date(Date.now() + 1_000),
        keyHash: digest('expiring-source-key'),
        requestHash: digest('expiring-source-request'),
      }),
    });
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
      apiPreviews.acceptPreview({
        workspaceId: workspaceA,
        ...input({
          input: {
            kind: 'prior_preview',
            previewRunId: expiring.previewRunId,
          },
          keyHash: digest('expired-consumer-key'),
          requestHash: digest('expired-consumer-request'),
        }),
      }),
    ).rejects.toBeInstanceOf(PriorPreviewInputUnavailableError);
  });

  it('hides previews across workspaces and prevents API pin mutation', async () => {
    const accepted = await apiPreviews.acceptPreview({
      workspaceId: workspaceA,
      ...input(),
    });
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
    const accepted = await apiPreviews.acceptPreview({
      workspaceId: workspaceA,
      ...input(),
    });
    await ownerWorkspaceQuery(
      workspaceA,
      `update app.preview_runs
       set status = 'succeeded', started_at = now(), completed_at = now(),
           output_ref = '{"kind":"inline","value":{"ok":true}}'
       where id = $1`,
      [accepted.previewRunId],
    );
    await expect(
      apiPreviews.readPreview({
        workspaceId: workspaceA,
        actorUserId: actorId,
        previewRunId: accepted.previewRunId,
      }),
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
      apiPreviews.readPreview({
        workspaceId: workspaceA,
        actorUserId: actorId,
        previewRunId: accepted.previewRunId,
      }),
    ).resolves.toMatchObject({
      output: { kind: 'inline', value: { ok: true } },
    });
    await expect(
      apiPreviews.readPreview({
        workspaceId: workspaceB,
        actorUserId: actorId,
        previewRunId: accepted.previewRunId,
      }),
    ).resolves.toBeNull();

    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        readPreviewRun(
          transaction,
          {
            actorUserId: actorId,
            previewRunId: accepted.previewRunId,
          },
          'builder',
          accepted.expiresAt,
        ),
      ),
    ).resolves.toBeNull();
  });

  it('scopes preview reads and keeps the provider idempotency key fixed', async () => {
    const accepted = await apiPreviews.acceptPreview({
      workspaceId: workspaceA,
      ...input(),
    });
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
      ).rejects.toSatisfy((error: unknown) => hasPostgresCode(error, '42501'));
    });
  });

  it.each([
    {
      case: 'an expiry in the past',
      expiresAt: -minute,
      executionDeadlineAt: -2 * minute,
      reason: 'retention',
    },
    {
      case: 'an expiry beyond seven days',
      expiresAt: sevenDays + minute,
      executionDeadlineAt: minute,
      reason: 'retention',
    },
    {
      case: 'a deadline in the past',
      expiresAt: minute,
      executionDeadlineAt: -minute,
      reason: 'deadline',
    },
    {
      case: 'a deadline beyond five minutes',
      expiresAt: 60 * minute,
      executionDeadlineAt: fiveMinutes + minute,
      reason: 'deadline',
    },
    {
      case: 'a deadline after the expiry',
      expiresAt: 2 * minute,
      executionDeadlineAt: 3 * minute,
      reason: 'deadline',
    },
  ] as const)(
    'refuses $case',
    async ({ expiresAt, executionDeadlineAt, reason }) => {
      const now = Date.now();

      await expect(
        apiPreviews.acceptPreview({
          workspaceId: workspaceA,
          ...input({
            expiresAt: new Date(now + expiresAt),
            executionDeadlineAt: new Date(now + executionDeadlineAt),
          }),
        }),
      ).rejects.toStrictEqual(new PreviewAdmissionDeniedError(reason));
    },
  );

  it('accepts an expiry and a deadline just inside both maxima', async () => {
    const now = Date.now();

    await expect(
      apiPreviews.acceptPreview({
        workspaceId: workspaceA,
        ...input({
          expiresAt: new Date(now + sevenDays - minute),
          executionDeadlineAt: new Date(now + fiveMinutes - 10_000),
        }),
      }),
    ).resolves.toHaveProperty('previewRunId');
  });
});
