import { appendAuditFact } from '../../governance/audit/events.repository.js';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { previewRuns } from '../../schema/runs/execution.js';
import { usageEvents } from '../../schema/foundation.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { PreviewAttemptStateError } from '../errors.js';
import type { PreviewStatus } from '../contract.js';

export async function appendPreviewTerminalFacts(
  client: PoolClient,
  input: Readonly<{
    previewAttemptId: string;
    previewRunId: string;
    status: Exclude<PreviewStatus, 'queued' | 'running'>;
    workspaceId: string;
  }>,
): Promise<void> {
  const db = drizzle(client);
  const result = await db
    .select({
      actorUserId: previewRuns.actorUserId,
      workflowId: previewRuns.workflowId,
      nodeId: previewRuns.nodeId,
      definitionKey: previewRuns.definitionKey,
      definitionVersion: previewRuns.definitionVersion,
      executorKey: previewRuns.executorKey,
      executorVersion: previewRuns.executorVersion,
      sideEffectClass: previewRuns.sideEffectClass,
      mayContactProvider: previewRuns.mayContactProvider,
      mayCauseExternalSideEffect: previewRuns.mayCauseExternalSideEffect,
      dryRun: previewRuns.dryRun,
      requestId: previewRuns.requestId,
      traceId: previewRuns.traceId,
    })
    .from(previewRuns)
    .where(
      and(
        eq(previewRuns.workspaceId, input.workspaceId),
        eq(previewRuns.id, input.previewRunId),
      ),
    )
    .catch(rethrowQueryFailure);
  const run = result[0];
  if (run === undefined)
    throw new PreviewAttemptStateError('terminal_facts_run_missing');
  const { actorUserId, requestId, traceId, ...metadata } = run;
  await appendAuditFact(client, {
    workspaceId: input.workspaceId,
    actorId: actorUserId,
    action: 'preview.execution_terminal',
    targetType: 'preview-run',
    targetId: input.previewRunId,
    requestId,
    traceId,
    metadata: {
      status: input.status,
      ...metadata,
      previewAttemptId: input.previewAttemptId,
    },
  });
  await db
    .insert(usageEvents)
    .values({
      id: uuidv7(),
      workspaceId: input.workspaceId,
      category: 'preview_execution',
      quantity: 1,
      resourceType: 'preview-run',
      resourceId: input.previewRunId,
      idempotencyKey: `preview-terminal:${input.previewRunId}`,
      metadata: sql`${JSON.stringify({ status: input.status, definitionKey: run.definitionKey, executorKey: run.executorKey, sideEffectClass: run.sideEffectClass })}::jsonb`,
    })
    .catch(rethrowQueryFailure);
}
