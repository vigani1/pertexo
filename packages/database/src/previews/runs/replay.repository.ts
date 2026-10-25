import type {
  PreviewReplayRecord,
  ResolvePreviewReplayInput,
} from './contract.js';

import { and, eq, gt } from 'drizzle-orm';
import { parseStoredExecutionValue } from '../../platform/stored-execution-value.js';

import { PreviewAcceptanceCorruptError } from '../errors.js';
import {
  assertPreviewActor,
  previewWorkflowVisible,
} from './acceptance/authority.queries.js';
import { readExistingAcceptance } from './acceptance/replay.queries.js';

import { previewAttempts, previewRuns } from '../../schema.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';

export async function resolvePreviewReplay(
  transaction: WorkspaceTransaction,
  input: ResolvePreviewReplayInput,
  now: Date = new Date(),
): Promise<PreviewReplayRecord | null> {
  const parsed = input;
  await assertPreviewActor(transaction, parsed.actorUserId);
  if (
    !(await previewWorkflowVisible(
      transaction,
      parsed.actorUserId,
      parsed.workflowId,
      'workflow:update',
    ))
  )
    return null;
  const existing = await readExistingAcceptance(transaction, {
    keyHash: parsed.keyHash,
    operation: 'preview.execute',
    requestHash: parsed.requestHash,
    scope: `${parsed.actorUserId}:${parsed.workflowId}`,
  });
  if (existing === null) return null;
  const rows = await transaction.db
    .select({
      id: previewRuns.id,
      workspaceId: previewRuns.workspaceId,
      workflowId: previewRuns.workflowId,
      draftRevision: previewRuns.draftRevision,
      nodeId: previewRuns.nodeId,
      status: previewRuns.status,
      sideEffectClass: previewRuns.sideEffectClass,
      mayContactProvider: previewRuns.mayContactProvider,
      mayCauseExternalSideEffect: previewRuns.mayCauseExternalSideEffect,
      dryRun: previewRuns.dryRun,
      pinnedSampleId: previewRuns.pinnedSampleId,
      outputRef: previewRuns.outputRef,
      createdAt: previewRuns.createdAt,
      completedAt: previewRuns.completedAt,
      codeDiagnostics: previewAttempts.codeDiagnostics,
      expiresAt: previewRuns.expiresAt,
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
        eq(previewRuns.id, existing.previewRunId),
        gt(previewRuns.expiresAt, now),
      ),
    )
    .limit(1);
  const replay = rows[0];
  if (replay === undefined) return null;
  if (replay.workflowId !== parsed.workflowId)
    throw new PreviewAcceptanceCorruptError();
  const {
    outputRef,
    pinnedSampleId,
    completedAt,
    codeDiagnostics,
    ...summary
  } = replay;
  return Object.freeze({
    ...summary,
    ...(codeDiagnostics === null ? {} : { codeDiagnostics: codeDiagnostics }),
    ...(pinnedSampleId === null
      ? {}
      : {
          pinnedSampleId,
          completedAt,
          output: parseStoredExecutionValue(outputRef),
        }),
    status: replay.status,
    sideEffectClass: replay.sideEffectClass,
    dryRun: replay.dryRun,
  });
}
