import { and, eq } from 'drizzle-orm';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { workflowManualStartRejections } from '@pertexo/database/schema';
import { IdempotencyRequestConflictError } from './acceptance/errors.js';

export type ManualStartIdentity = Readonly<{
  workflowId: string;
  scope: string;
  idempotencyKeyHash: string;
  requestHash: string;
}>;
export type ManualStartRejection = Readonly<{
  kind: 'published_version_conflict';
  expectedPublishedVersionId: string;
  observedPublishedVersionId: string;
}>;

/** Caller has already resolved successful acceptance under the same command lock. */
export async function readManualStartRejection(
  transaction: WorkspaceTransaction,
  identity: ManualStartIdentity,
): Promise<ManualStartRejection | null> {
  const [row] = await transaction.db
    .select({
      requestHash: workflowManualStartRejections.requestHash,
      expectedVersionId: workflowManualStartRejections.expectedVersionId,
      observedVersionId: workflowManualStartRejections.observedVersionId,
    })
    .from(workflowManualStartRejections)
    .where(
      and(
        eq(workflowManualStartRejections.workspaceId, transaction.workspaceId),
        eq(workflowManualStartRejections.scope, identity.scope),
        eq(workflowManualStartRejections.keyHash, identity.idempotencyKeyHash),
      ),
    );
  if (row === undefined) return null;
  if (row.requestHash !== identity.requestHash)
    throw new IdempotencyRequestConflictError();
  return Object.freeze({
    kind: 'published_version_conflict',
    expectedPublishedVersionId: row.expectedVersionId,
    observedPublishedVersionId: row.observedVersionId,
  });
}

export async function recordManualStartRejection(
  transaction: WorkspaceTransaction,
  identity: ManualStartIdentity,
  expectedPublishedVersionId: string,
  observedPublishedVersionId: string,
): Promise<ManualStartRejection> {
  await transaction.db.insert(workflowManualStartRejections).values({
    workspaceId: transaction.workspaceId,
    workflowId: identity.workflowId,
    scope: identity.scope,
    keyHash: identity.idempotencyKeyHash,
    requestHash: identity.requestHash,
    expectedVersionId: expectedPublishedVersionId,
    observedVersionId: observedPublishedVersionId,
  });
  return Object.freeze({
    kind: 'published_version_conflict',
    expectedPublishedVersionId,
    observedPublishedVersionId,
  });
}
