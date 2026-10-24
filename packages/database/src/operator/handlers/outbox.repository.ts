import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import type { OperatorDecision } from './contract.js';
import { optionalDate } from './enqueue.js';

const outboxRowSchema = z.object({
  failed_at: optionalDate,
  last_error_code: z.string().nullable(),
  publish_attempts: z.coerce.number().int().nonnegative(),
  published_at: optionalDate,
});

/** Makes a failed outbox event available to the dispatcher again. */
export async function redispatchFailedOutbox(
  transaction: WorkspaceTransaction,
  input: Readonly<{ outboxEventId: string; dryRun: boolean }>,
): Promise<OperatorDecision> {
  const rows = await transaction.db.execute(sql`
    select published_at, failed_at, publish_attempts, last_error_code
    from app.outbox_events
    where workspace_id = ${transaction.workspaceId} and id = ${input.outboxEventId}
    for update
  `);
  const outbox =
    rows.rows[0] === undefined
      ? undefined
      : outboxRowSchema.parse(rows.rows[0]);
  const outcome = redispatchOutcome(outbox, input);
  if (outcome === 'redispatched')
    await transaction.db.execute(sql`
      update app.outbox_events
      set available_at = clock_timestamp(), lease_owner = null, lease_token = null,
          lease_expires_at = null, publish_attempts = 0, failed_at = null,
          last_error_code = null, updated_at = clock_timestamp()
      where workspace_id = ${transaction.workspaceId} and id = ${input.outboxEventId}
    `);
  const prior = {
    priorErrorCode: outbox?.last_error_code ?? null,
    priorFailedAt: outbox?.failed_at ?? null,
    priorPublishAttempts: outbox?.publish_attempts ?? null,
  };
  return {
    outcome,
    result: { outcome, ...prior },
    auditMetadata: prior,
  };
}

function redispatchOutcome(
  outbox: z.output<typeof outboxRowSchema> | undefined,
  input: Readonly<{ dryRun: boolean }>,
): string {
  if (outbox === undefined) return 'not_found';
  if (outbox.published_at !== null) return 'already_published';
  if (outbox.failed_at === null) return 'not_failed';
  return input.dryRun ? 'would_redispatch' : 'redispatched';
}
