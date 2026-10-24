import type { CodeDiagnostics } from '@pertexo/node-sdk';
import { parseStoredExecutionValue } from '../../platform/stored-execution-value.js';
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';

import {
  assertPreviewActor,
  previewWorkflowVisible,
  PreviewAcceptanceCorruptError,
  readExistingAcceptance,
  type PreviewStatus,
} from './acceptance.repository.js';
import { previewRuns, previewAttempts } from '../../schema.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { sha256HexSchema } from '../../platform/persisted-primitives.js';

export type ResolvePreviewReplayInput = Readonly<{
  actorUserId: string;
  workflowId: string;
  keyHash: string;
  requestHash: string;
}>;

export type PreviewReplayRecord = Readonly<{
  codeDiagnostics?: CodeDiagnostics;
  id: string;
  workspaceId: string;
  workflowId: string;
  draftRevision: number;
  nodeId: string;
  status: PreviewStatus;
  sideEffectClass: 'safe' | 'idempotent_with_key' | 'unsafe';
  mayContactProvider: boolean;
  mayCauseExternalSideEffect: boolean;
  dryRun: 'not_supported' | 'provider_supported';
  pinnedSampleId?: string | null;
  output?: ReturnType<typeof parseStoredExecutionValue> | null;
  completedAt?: Date | null;
  createdAt: Date;
  expiresAt: Date;
}>;

export async function resolvePreviewReplay(
  transaction: WorkspaceTransaction,
  input: ResolvePreviewReplayInput,
  now: Date = new Date(),
): Promise<PreviewReplayRecord | null> {
  const parsed = z
    .object({
      actorUserId: z.uuid(),
      workflowId: z.uuid(),
      keyHash: sha256HexSchema,
      requestHash: sha256HexSchema,
    })
    .strict()
    .parse(input);
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
