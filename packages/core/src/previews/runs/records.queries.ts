import { sql } from 'drizzle-orm';
import { readTransactionFolderScope } from '../../shared/facts.queries.js';
import { workflowScopeSql } from '../../shared/scope.queries.js';

import { and, eq, gt } from 'drizzle-orm';

import { parseStoredExecutionValue } from '../../runs/values/stored-execution.js';
import { previewAttempts, previewRuns } from '@pertexo/database/schema';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { assertPreviewActor } from './acceptance/authority.queries.js';
import type { PreviewRunRecord } from './acceptance/contract.js';

export async function readPreviewRun(
  transaction: WorkspaceTransaction,
  input: Readonly<{ actorUserId: string; previewRunId: string }>,
  now: Date = new Date(),
): Promise<PreviewRunRecord | null> {
  const actorUserId = input.actorUserId;
  const previewRunId = input.previewRunId;
  await assertPreviewActor(transaction, actorUserId);
  const resources = await readTransactionFolderScope(transaction, {
    workspaceId: transaction.workspaceId,
    actorId: actorUserId,
  });
  const rows = await transaction.db
    .select({
      completedAt: previewRuns.completedAt,
      codeDiagnostics: previewAttempts.codeDiagnostics,
      errorSummary: previewAttempts.errorSummary,
      createdAt: previewRuns.createdAt,
      draftRevision: previewRuns.draftRevision,
      dryRun: previewRuns.dryRun,
      expiresAt: previewRuns.expiresAt,
      id: previewRuns.id,
      mayContactProvider: previewRuns.mayContactProvider,
      mayCauseExternalSideEffect: previewRuns.mayCauseExternalSideEffect,
      nodeId: previewRuns.nodeId,
      outputRef: previewRuns.outputRef,
      pinnedSampleId: previewRuns.pinnedSampleId,
      safeErrorCode: previewRuns.safeErrorCode,
      sideEffectClass: previewRuns.sideEffectClass,
      startedAt: previewRuns.startedAt,
      status: previewRuns.status,
      workflowId: previewRuns.workflowId,
      workspaceId: previewRuns.workspaceId,
    })
    .from(previewRuns)
    .leftJoin(
      previewAttempts,
      and(
        eq(previewAttempts.workspaceId, previewRuns.workspaceId),
        eq(previewAttempts.previewRunId, previewRuns.id),
      ),
    )
    .where(
      and(
        eq(previewRuns.workspaceId, transaction.workspaceId),
        eq(previewRuns.id, previewRunId),
        workflowScopeSql(resources, sql`${previewRuns.workflowId}`),
        gt(previewRuns.expiresAt, now),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return Object.freeze({
    ...(row.codeDiagnostics === null
      ? {}
      : { codeDiagnostics: row.codeDiagnostics }),
    ...(row.errorSummary === null ? {} : { errorSummary: row.errorSummary }),
    id: row.id,
    workspaceId: row.workspaceId,
    workflowId: row.workflowId,
    draftRevision: row.draftRevision,
    nodeId: row.nodeId,
    status: row.status,
    sideEffectClass: row.sideEffectClass,
    mayContactProvider: row.mayContactProvider,
    mayCauseExternalSideEffect: row.mayCauseExternalSideEffect,
    dryRun: row.dryRun,
    output:
      row.outputRef === null ? null : parseStoredExecutionValue(row.outputRef),
    pinnedSampleId: row.pinnedSampleId,
    safeErrorCode: row.safeErrorCode,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    expiresAt: row.expiresAt,
  });
}
