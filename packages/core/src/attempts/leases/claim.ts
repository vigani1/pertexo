import { withTenantScopedClient } from '@pertexo/database/primitives';
import { appendAttemptEvent } from '../attempt-events.repository.js';
import { lockClaimCandidate } from './candidates.repository.js';
import { markNodeRunStarted, startAttemptLease } from './lease.repository.js';
import type { Pool } from 'pg';
import type { z } from 'zod';
import {
  DeliveryMismatch,
  NodeAttemptStateCorruptError,
} from '../node-attempt.errors.js';
import { readyClaimScope } from './claim-refusal.repository.js';
import type { branchContextSchema } from '../validation/attempt-scope.schemas.js';
import {
  SETTLED_ATTEMPT_STATUSES,
  type ClaimDeliveryInput,
  type NodeAttemptClaimResult,
  type NodeAttemptLease,
} from '../node-attempt.js';
import {
  auditMismatch,
  claimReceipt,
  completeReceipt,
  validateDelivery,
} from '../completion/receipts.repository.js';

export async function claimNodeAttemptDelivery(
  pool: Pool,
  input: ClaimDeliveryInput,
): Promise<NodeAttemptClaimResult> {
  try {
    return await withTenantScopedClient(
      pool,
      { workspaceId: input.workspaceId },
      async (client) => {
        await validateDelivery(client, input);
        const receipt = await claimReceipt(
          client,
          input.workspaceId,
          input.delivery,
        );
        if (receipt === 'completed')
          return Object.freeze({ kind: 'duplicate' as const });

        const { row, runRow } = await lockClaimCandidate(client, input);
        if (SETTLED_ATTEMPT_STATUSES.includes(row.attemptStatus)) {
          await completeReceipt(client, input.workspaceId, input.delivery);
          return Object.freeze({ kind: 'duplicate' as const });
        }
        // A live lease has an owner and an expired one belongs to stalled-work
        // recovery, so a repeat of this job has nothing left to do either way.
        if (row.attemptStatus === 'running')
          return Object.freeze({ kind: 'duplicate' as const });
        let scope;
        try {
          scope = readyClaimScope(row);
        } catch (error) {
          if (error instanceof NodeAttemptStateCorruptError)
            throw new NodeAttemptStateCorruptError(
              {
                workspaceId: input.workspaceId,
                runId: input.runId,
                nodeRunId: input.nodeRunId,
                attemptId: input.attemptId,
                delivery: input.delivery,
                checkpointRevision: runRow.checkpointRevision,
                fenceToken: row.fenceToken,
              },
              { cause: error },
            );
          throw error;
        }

        const claim = await startAttemptLease(client, input);
        if (claim === undefined) throw new NodeAttemptStateCorruptError();
        await markNodeRunStarted(client, input);
        await appendAttemptEvent(client, {
          workspaceId: input.workspaceId,
          runId: input.runId,
          type: 'node.started',
          payload: {
            nodeRunId: input.nodeRunId,
            attemptId: input.attemptId,
            invocationKey: row.invocationKey,
            nodeId: row.nodeId,
            attemptNumber: row.attemptNumber,
          },
        });
        const lease = claimedAttemptLease(input, {
          row,
          runRow,
          scope,
          claim,
        });
        return Object.freeze({ kind: 'claimed' as const, lease });
      },
      { signal: input.signal },
    );
  } catch (error: unknown) {
    if (error instanceof DeliveryMismatch)
      return auditMismatch(
        pool,
        input.workspaceId,
        input.delivery,
        input.signal,
      );
    throw error;
  }
}

function claimedAttemptLease(
  input: ClaimDeliveryInput,
  {
    row,
    runRow,
    scope,
    claim,
  }: Readonly<{
    row: Awaited<ReturnType<typeof lockClaimCandidate>>['row'];
    runRow: Awaited<ReturnType<typeof lockClaimCandidate>>['runRow'];
    scope: z.output<typeof branchContextSchema>;
    claim: Pick<NodeAttemptLease, 'fenceToken' | 'leaseExpiresAt'>;
  }>,
): NodeAttemptLease {
  const { branchPath, iterationPath } = scope;
  const lease: NodeAttemptLease = Object.freeze({
    workspaceId: input.workspaceId,
    runId: input.runId,
    workflowVersionId: runRow.workflowVersionId,
    checkpointRevision: runRow.checkpointRevision,
    nodeRunId: input.nodeRunId,
    attemptId: input.attemptId,
    attemptNumber: row.attemptNumber,
    admissionKind: row.admissionKind,
    invocationKey: row.invocationKey,
    nodeId: row.nodeId,
    ...(branchPath === undefined || branchPath.length === 0
      ? {}
      : { branchPath }),
    ...(iterationPath === undefined || iterationPath.length === 0
      ? {}
      : { iterationPath }),
    sideEffectClass: row.sideEffectClass,
    ...(row.providerIdempotencyKey === null
      ? {}
      : { providerIdempotencyKey: row.providerIdempotencyKey }),
    ...(row.providerDispatchBinding === null
      ? {}
      : { providerDispatchBinding: row.providerDispatchBinding }),
    ...(row.providerDispatchUnresolved
      ? { providerDispatchUnresolved: true as const }
      : {}),
    workerId: input.workerId,
    fenceToken: claim.fenceToken,
    leaseExpiresAt: new Date(claim.leaseExpiresAt),
    delivery: Object.freeze(input.delivery),
  });
  if (!Number.isSafeInteger(lease.fenceToken) || lease.fenceToken <= 0)
    throw new NodeAttemptStateCorruptError();

  return lease;
}
