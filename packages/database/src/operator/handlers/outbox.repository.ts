import { redispatchOutcome } from '@pertexo/workflow-engine';
import { and, eq, sql } from 'drizzle-orm';
import { outboxEvents } from '../../schema/transport.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import type { OperatorDecision } from './contract.js';

/** Makes a failed outbox event available to the dispatcher again. */
export async function redispatchFailedOutbox(
  transaction: WorkspaceTransaction,
  input: Readonly<{ outboxEventId: string; dryRun: boolean }>,
): Promise<OperatorDecision> {
  const [outbox] = await transaction.db
    .select({
      publishedAt: outboxEvents.publishedAt,
      failedAt: outboxEvents.failedAt,
      publishAttempts: outboxEvents.publishAttempts,
      lastErrorCode: outboxEvents.lastErrorCode,
    })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.workspaceId, transaction.workspaceId),
        eq(outboxEvents.id, input.outboxEventId),
      ),
    )
    .for('update');
  const outcome = redispatchOutcome(outbox, input);
  if (outcome === 'redispatched')
    await transaction.db
      .update(outboxEvents)
      .set({
        availableAt: sql`clock_timestamp()`,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        publishAttempts: 0,
        // A row given up on after publishing still has its job in Redis's retained
        // sets, and BullMQ ignores an add under a job ID it retains.
        redeliveries: sql`${outboxEvents.redeliveries}+1`,
        failedAt: null,
        lastErrorCode: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(outboxEvents.workspaceId, transaction.workspaceId),
          eq(outboxEvents.id, input.outboxEventId),
        ),
      );
  const prior = {
    priorErrorCode: outbox?.lastErrorCode ?? null,
    priorFailedAt: outbox?.failedAt?.toISOString() ?? null,
    priorPublishAttempts: outbox?.publishAttempts ?? null,
  };
  return {
    outcome,
    result: { outcome, ...prior },
    auditMetadata: prior,
  };
}
