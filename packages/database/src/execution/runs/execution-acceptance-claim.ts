import { generatePersistedId } from '../../platform/persisted-id.js';
import { idempotencyRecords } from '../../schema.js';
import type { WorkspaceTransaction } from '../../tenant-access/workspace.js';
import {
  IDEMPOTENCY_STATUS,
  type ParsedAcceptWorkflowRunInput,
} from './execution-acceptance-contract.js';

export interface WorkflowRunAcceptanceIdentifiers {
  readonly idempotencyRecordId: string;
  readonly runId: string;
  readonly outboxEventId: string;
}

/** Canonical allocation order remains claim, candidate run, initial outbox. */
export function allocateWorkflowRunAcceptanceIdentifiers(): WorkflowRunAcceptanceIdentifiers {
  const idempotencyRecordId = generatePersistedId();
  const runId = generatePersistedId();
  const outboxEventId = generatePersistedId();
  return Object.freeze({ idempotencyRecordId, runId, outboxEventId });
}

export async function claimWorkflowRunAcceptance(
  transaction: WorkspaceTransaction,
  input: Pick<
    ParsedAcceptWorkflowRunInput,
    'operation' | 'scope' | 'keyHash' | 'requestHash'
  >,
  identifiers: WorkflowRunAcceptanceIdentifiers,
): Promise<boolean> {
  const claim = await transaction.db
    .insert(idempotencyRecords)
    .values({
      id: identifiers.idempotencyRecordId,
      workspaceId: transaction.workspaceId,
      operation: input.operation,
      scope: input.scope,
      keyHash: input.keyHash,
      requestHash: input.requestHash,
      status: IDEMPOTENCY_STATUS.inProgress,
      resourceId: identifiers.runId,
      resultRef: {},
    })
    .onConflictDoNothing({
      target: [
        idempotencyRecords.workspaceId,
        idempotencyRecords.operation,
        idempotencyRecords.scope,
        idempotencyRecords.keyHash,
      ],
    })
    .returning({ id: idempotencyRecords.id });
  return claim.length === 1;
}
