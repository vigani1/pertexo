import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { inboxReceipts } from '@pertexo/database/schema';
import { coordinatorConsumerName } from '../advance/receipts.repository.js';

type AttemptColumns = Readonly<{
  status: AnyPgColumn;
  leaseExpiresAt: AnyPgColumn;
}>;
type DeliveryColumns = Readonly<{ id: AnyPgColumn; jobName: AnyPgColumn }>;
type PublicationColumns = Readonly<{
  publishedAt: AnyPgColumn;
  failedAt: AnyPgColumn;
  availableAt: AnyPgColumn;
}>;

export const UNPUBLISHED_RUN_JOB_GRACE = sql`interval '60 seconds'`;
export function stalledRunEligible(status: AnyPgColumn) {
  return inArray(status, ['running', 'waiting']);
}
export function stalledLeaseEligible(attempt: AttemptColumns, asOf: SQL) {
  return and(
    eq(attempt.status, 'running'),
    isNotNull(attempt.leaseExpiresAt),
    lte(attempt.leaseExpiresAt, asOf),
  );
}
export function stalledPublicationEligible(
  event: PublicationColumns,
  asOf: SQL,
) {
  return and(
    isNull(event.publishedAt),
    isNull(event.failedAt),
    lte(event.availableAt, sql`${asOf}-${UNPUBLISHED_RUN_JOB_GRACE}`),
  );
}
/** A watch alone does not prove work is missing after its consumer completed. */
export function stalledDeliveryUnconfirmed(
  db: Pick<NodePgDatabase, 'select'>,
  event: DeliveryColumns,
  attemptStatus: AnyPgColumn,
) {
  return or(
    eq(attemptStatus, 'ready'),
    and(
      eq(event.jobName, 'advance-workflow-run'),
      notExists(
        db
          .select({ one: sql`1` })
          .from(inboxReceipts)
          .where(
            and(
              eq(inboxReceipts.consumerName, coordinatorConsumerName),
              eq(inboxReceipts.messageId, event.id),
              isNotNull(inboxReceipts.completedAt),
            ),
          ),
      ),
    ),
  );
}
