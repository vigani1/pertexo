import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';

import {
  assertPreviewActor,
  PREVIEW_STATUS,
  PreviewAcceptanceCorruptError,
  readExistingAcceptance,
  type PreviewStatus,
} from './preview-execution-acceptance.js';
import { previewRuns } from '../schema.js';
import type { WorkspaceTransaction } from '../tenant-access/workspace.js';
import { sha256HexSchema } from '../validation/persisted-primitives.js';

export type ResolvePreviewReplayInput = Readonly<{
  actorUserId: string;
  workflowId: string;
  keyHash: string;
  requestHash: string;
}>;

export type PreviewReplayRecord = Readonly<{
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
  createdAt: Date;
  expiresAt: Date;
}>;

const previewStatusSchema = z.enum(
  Object.values(PREVIEW_STATUS) as [PreviewStatus, ...PreviewStatus[]],
);

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
      createdAt: previewRuns.createdAt,
      expiresAt: previewRuns.expiresAt,
    })
    .from(previewRuns)
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
  return Object.freeze({
    ...replay,
    status: previewStatusSchema.parse(replay.status),
    sideEffectClass: z
      .enum(['safe', 'idempotent_with_key', 'unsafe'])
      .parse(replay.sideEffectClass),
    dryRun: z
      .enum(['not_supported', 'provider_supported'])
      .parse(replay.dryRun),
  });
}
