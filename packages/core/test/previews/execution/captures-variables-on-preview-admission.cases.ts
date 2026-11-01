import { and, count, eq } from 'drizzle-orm';

import { expect, it } from 'vitest';
import { createRetentionDatabase } from '../../../src/lifecycle/retention/repository.js';
import { createPreviewRetentionCoordinator } from '../../../src/lifecycle/previews/repository.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';

import { acceptPreviewRun } from '../../../src/previews/runs/acceptance.repository.js';
import { PreviewIdempotencyConflictError } from '../../../src/previews/errors.js';
import { resolvePreviewReplay } from '../../../src/previews/runs/replay.repository.js';
import {
  auditEvents,
  outboxEvents,
  previewAttempts,
  previewRuns,
  workspaceVariableSetRevisions,
} from '@pertexo/database/schema';

import {
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
} from './fixture.js';

export function registerCapturesVariablesOnPreviewAdmission(): void {
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
