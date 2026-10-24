import { and, eq, sql } from 'drizzle-orm';
import { outboxEvents } from '../../schema/transport.js';

import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import type { OperatorDecision } from './contract.js';

type OutboxState = Pick<
  typeof outboxEvents.$inferSelect,
  'failedAt' | 'lastErrorCode' | 'publishAttempts' | 'publishedAt'
>;

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

function redispatchOutcome(
  outbox: OutboxState | undefined,
  input: Readonly<{ dryRun: boolean }>,
): string {
  if (outbox === undefined) return 'not_found';
  if (outbox.publishedAt !== null) return 'already_published';
  if (outbox.failedAt === null) return 'not_failed';
  return input.dryRun ? 'would_redispatch' : 'redispatched';
}
