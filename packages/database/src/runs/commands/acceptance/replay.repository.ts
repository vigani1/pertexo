import { acceptanceReplayInputSchema } from './input.js';
import type { WorkflowRunAcceptanceReplayInput } from './contract.js';
import { and, eq } from 'drizzle-orm';

import type { z } from 'zod';

import { idempotencyRecords, workflowRuns } from '../../../schema.js';

import type { WorkspaceTransaction } from '../../../tenant-access/transactions.js';

import type { acceptWorkflowRunInputSchema } from './input.js';
import { resultRefSchema } from './receipt.js';
import { IDEMPOTENCY_STATUS } from './vocabulary.js';
import type { AcceptedWorkflowRun } from './contract.js';
import {
  IdempotencyRequestConflictError,
  IdempotencyRecordCorruptError,
} from './errors.js';

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

/** Resolve a completed exact request replay before reading current workflow state. */
export async function readWorkflowRunAcceptanceReplay(
  transaction: WorkspaceTransaction,
  input: WorkflowRunAcceptanceReplayInput,
): Promise<AcceptedWorkflowRun | null> {
  const parsed = acceptanceReplayInputSchema.parse(input);
  return readExistingAcceptance(transaction, parsed, { kind: 'request_only' });
}
