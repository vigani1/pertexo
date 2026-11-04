import { evidenceOutcome } from '@pertexo/workflow-engine';
import { and, eq, sql } from 'drizzle-orm';
import {
  nodeAttempts,
  operatorUnknownOutcomeEvidence,
} from '@pertexo/database/schema';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { withoutNulls, type OperatorDecision } from './decision.js';
import {
  readLockedAttempt,
  settleExpiredAttempt,
} from '../../attempts/attempt-reconciliation.repository.js';

export async function reconcileAttempt(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    commandId: string;
    attemptId: string;
    expectedFenceToken: number;
    action: 'reclaim' | 'outcome_unknown';
    dryRun: boolean;
  }>,
): Promise<OperatorDecision> {
  const { action, expectedFenceToken: fence } = input;
  const attempt = await readLockedAttempt(transaction, input.attemptId);
  const { outcome, outboxEventId } = await settleExpiredAttempt(
    transaction,
    attempt,
    { ...input, source: { operatorCommandId: input.commandId } },
  );
  const changed = outcome === 'reclaimed' || outcome === 'marked_unknown';
  return {
    outcome,
    result: withoutNulls({
      action,
      fenceToken: changed ? fence + 1 : fence,
      outboxEventId,
      outcome,
    }),
  };
}

/** Records what an operator learned about an unknown outcome and asks a worker to reconcile it. */
export async function recordUnknownOutcomeEvidence(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    commandId: string;
    attemptId: string;
    evidenceKind: string;
    evidenceRef: string;
  }>,
): Promise<OperatorDecision> {
  const [attempt] = await transaction.db
    .select({ status: nodeAttempts.status })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.workspaceId, transaction.workspaceId),
        eq(nodeAttempts.id, input.attemptId),
      ),
    )
    .for('update');
  const status = attempt?.status;
  const outcome = evidenceOutcome(status);

  if (outcome === 'evidence_recorded') {
    await transaction.db.insert(operatorUnknownOutcomeEvidence).values({
      commandId: input.commandId,
      workspaceId: transaction.workspaceId,
      attemptId: input.attemptId,
      evidenceKind: input.evidenceKind,
      evidenceRef: sql`${input.evidenceRef}::jsonb`,
    });
  }
  return {
    outcome,
    result: {
      evidenceKind: input.evidenceKind,
      outboxEventId: null,
      outcome,
    },
  };
}
