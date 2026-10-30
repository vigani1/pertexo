import { and, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { outboxEvents } from '../../schema/transport.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type {
  ObserveOutboxBacklogInput,
  OutboxBacklogSnapshot,
} from './contract.js';

export async function observeOutboxBacklog(
  pool: Pool,
  input: ObserveOutboxBacklogInput,
): Promise<OutboxBacklogSnapshot> {
  if (input.enabledJobNames.length === 0) return Object.freeze({ backlog: 0 });
  const [row] = await drizzle(pool)
    .select({
      backlog: sql<number>`count(*)::integer`,
      oldestAgeSeconds: sql<
        number | null
      >`extract(epoch from (clock_timestamp()-min(${outboxEvents.availableAt})))::double precision`,
    })
    .from(outboxEvents)
    .where(
      and(
        isNull(outboxEvents.publishedAt),
        isNull(outboxEvents.failedAt),
        inArray(outboxEvents.jobName, input.enabledJobNames),
        lte(outboxEvents.availableAt, sql`clock_timestamp()`),
        or(
          isNull(outboxEvents.leaseExpiresAt),
          lte(outboxEvents.leaseExpiresAt, sql`clock_timestamp()`),
        ),
      ),
    )
    .catch(rethrowQueryFailure);
  if (row === undefined)
    throw new Error('Outbox backlog observation returned no row');
  return Object.freeze({
    backlog: row.backlog,
    ...(row.oldestAgeSeconds === null
      ? {}
      : { oldestAgeSeconds: Math.max(0, row.oldestAgeSeconds) }),
  });
}
