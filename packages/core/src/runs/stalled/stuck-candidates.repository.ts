import { and, asc, gt, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { nodeAttempts, outboxEvents } from '@pertexo/database/schema';
import {
  stalledLeaseEligible,
  stalledPublicationEligible,
} from './stalled-eligibility.repository.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { RUN_DELIVERY_JOB_NAMES } from '../../outbox/dispatcher/outbox-dispatcher.store.js';
import type {
  StuckWorkCursor,
  StuckWorkPosition,
} from './stuck-work-cursor.js';

const STUCK_RUN_CANDIDATES_PER_LANE = 66;
const FAILED_OUTBOX_PAGE_SIZE = 200;
type StuckCandidateLane = Exclude<keyof StuckWorkCursor, 'asOf'>;

/** Keep PostgreSQL microseconds in the seek position; Date truncates them. */
function cursorTime(column: AnyPgColumn) {
  return sql<string>`to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Page raw indexed candidates before any ownership joins or receipt lookups. */
export async function readStuckCandidates(
  db: Pick<NodePgDatabase, 'select'>,
  lane: StuckCandidateLane,
  asOf: string,
  after: StuckWorkPosition | null | undefined,
) {
  if (after === null) return { ids: [], next: null };
  const { table, time, condition, limit } = candidateSource(lane, asOf);
  const candidates = await db
    .select({ id: table.id, time: cursorTime(time) })
    .from(table)
    .where(
      and(
        condition,
        after === undefined
          ? undefined
          : gt(
              sql`(${time},${table.id})`,
              sql`(${after.time}::timestamptz,${after.id}::uuid)`,
            ),
      ),
    )
    .orderBy(asc(time), asc(table.id))
    .limit(limit + 1)
    .catch(rethrowQueryFailure);
  const rows = candidates.slice(0, limit);
  const last = rows.at(-1);
  return {
    ids: rows.map((row) => row.id),
    next:
      candidates.length > limit && last !== undefined
        ? { time: last.time, id: last.id }
        : null,
  };
}

function candidateSource(lane: StuckCandidateLane, asOf: string) {
  const runDelivery = inArray(outboxEvents.jobName, RUN_DELIVERY_JOB_NAMES);
  switch (lane) {
    case 'leases':
      return {
        table: nodeAttempts,
        time: nodeAttempts.leaseExpiresAt,
        condition: stalledLeaseEligible(
          nodeAttempts,
          sql`${asOf}::timestamptz`,
        ),
        limit: STUCK_RUN_CANDIDATES_PER_LANE,
      };
    case 'deliveries':
      return {
        table: outboxEvents,
        time: outboxEvents.deliveryDueAt,
        condition: and(
          runDelivery,
          isNotNull(outboxEvents.deliveryDueAt),
          lte(outboxEvents.deliveryDueAt, sql`${asOf}::timestamptz`),
        ),
        limit: STUCK_RUN_CANDIDATES_PER_LANE,
      };
    case 'publications':
      return {
        table: outboxEvents,
        time: outboxEvents.availableAt,
        condition: and(
          runDelivery,
          stalledPublicationEligible(outboxEvents, sql`${asOf}::timestamptz`),
        ),
        limit: STUCK_RUN_CANDIDATES_PER_LANE,
      };
    case 'failures':
      return {
        table: outboxEvents,
        time: outboxEvents.failedAt,
        condition: and(
          isNotNull(outboxEvents.failedAt),
          lte(outboxEvents.failedAt, sql`${asOf}::timestamptz`),
        ),
        limit: FAILED_OUTBOX_PAGE_SIZE,
      };
  }
}
