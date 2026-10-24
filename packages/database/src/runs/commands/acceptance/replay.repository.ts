import { and, eq } from 'drizzle-orm';

import type { z } from 'zod';

import { idempotencyRecords, workflowRuns } from '../../../schema.js';

import type { WorkspaceTransaction } from '../../../tenant-access/transactions.js';

import {
  acceptWorkflowRunInputSchema,
  resultRefSchema,
  IDEMPOTENCY_STATUS,
  type AcceptedWorkflowRun,
  IdempotencyRequestConflictError,
  IdempotencyRecordCorruptError,
} from './contract.js';

type ReplayValidation =
  | Readonly<{ kind: 'request_only' }>
  | Readonly<{ kind: 'exact_initial_checkpoint'; hash: string }>;

export async function readExistingAcceptance(
  transaction: WorkspaceTransaction,
  input: Pick<
    z.output<typeof acceptWorkflowRunInputSchema>,
    'keyHash' | 'operation' | 'requestHash' | 'scope'
  >,
  replayValidation: ReplayValidation,
): Promise<AcceptedWorkflowRun | null> {
  const rows = await transaction.db
    .select({
      requestHash: idempotencyRecords.requestHash,
      resourceId: idempotencyRecords.resourceId,
      resultRef: idempotencyRecords.resultRef,
      idempotencyStatus: idempotencyRecords.status,
      acceptedAt: workflowRuns.createdAt,
      runStatus: workflowRuns.status,
    })
    .from(idempotencyRecords)
    .leftJoin(
      workflowRuns,
      and(
        eq(workflowRuns.workspaceId, idempotencyRecords.workspaceId),
        eq(workflowRuns.id, idempotencyRecords.resourceId),
      ),
    )
    .where(
      and(
        eq(idempotencyRecords.workspaceId, transaction.workspaceId),
        eq(idempotencyRecords.operation, input.operation),
        eq(idempotencyRecords.scope, input.scope),
        eq(idempotencyRecords.keyHash, input.keyHash),
      ),
    )
    .limit(1);
  const row = rows[0];

  if (row === undefined) {
    return null;
  }
  if (row.requestHash !== input.requestHash) {
    throw new IdempotencyRequestConflictError();
  }
  const resultRef = resultRefSchema.safeParse(row.resultRef);
  const { acceptedAt, runStatus } = row;
  const incompleteReceipt =
    row.idempotencyStatus !== IDEMPOTENCY_STATUS.completed ||
    acceptedAt === null ||
    !resultRef.success ||
    runStatus === null;
  if (incompleteReceipt) {
    throw new IdempotencyRecordCorruptError();
  }
  if (
    replayValidation.kind === 'exact_initial_checkpoint' &&
    resultRef.data.initialCheckpointHash !== replayValidation.hash
  ) {
    throw new IdempotencyRequestConflictError();
  }

  return Object.freeze({
    acceptedAt,
    duplicate: true,
    outboxEventId: resultRef.data.outboxEventId,
    runId: row.resourceId,
    status: runStatus,
  });
}

const acceptanceReplayInputSchema = acceptWorkflowRunInputSchema.pick({
  keyHash: true,
  operation: true,
  requestHash: true,
  scope: true,
});

export type WorkflowRunAcceptanceReplayInput = Readonly<
  z.input<typeof acceptanceReplayInputSchema>
>;

/** Resolve a completed exact request replay before reading current workflow state. */
export async function readWorkflowRunAcceptanceReplay(
  transaction: WorkspaceTransaction,
  input: WorkflowRunAcceptanceReplayInput,
): Promise<AcceptedWorkflowRun | null> {
  const parsed = acceptanceReplayInputSchema.parse(input);
  return readExistingAcceptance(transaction, parsed, { kind: 'request_only' });
}
