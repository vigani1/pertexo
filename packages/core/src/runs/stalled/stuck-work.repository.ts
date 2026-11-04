import { and, asc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  nodeAttempts,
  nodeRuns,
  outboxEvents,
  workflowRuns,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  stalledRunEligible,
  stalledLeaseEligible,
  stalledPublicationEligible,
  stalledDeliveryUnconfirmed,
  UNPUBLISHED_RUN_JOB_GRACE,
} from './stalled-eligibility.repository.js';
import {
  decodeStuckWorkCursor,
  encodeStuckWorkCursor,
} from './stuck-work-cursor.js';
import { readStuckCandidates } from './stuck-candidates.repository.js';
import type { StuckRun, StuckWork } from './stalled-work.types.js';

/** Bounded candidate pages, including empty pages whose history needs continuation. */
export async function readStuckWork(
  db: Pick<NodePgDatabase, 'select'>,
  cursor?: string,
): Promise<StuckWork> {
  const after = decodeStuckWorkCursor(cursor);
  const asOf = after?.asOf ?? (await databaseCursorTime(db));
  const leases = await readStuckCandidates(db, 'leases', asOf, after?.leases);
  const deliveries = await readStuckCandidates(
    db,
    'deliveries',
    asOf,
    after?.deliveries,
  );
  const publications = await readStuckCandidates(
    db,
    'publications',
    asOf,
    after?.publications,
  );
  const failures = await readStuckCandidates(
    db,
    'failures',
    asOf,
    after?.failures,
  );
  const rows = [
    ...(await readExpiredAttemptRuns(db, leases.ids, asOf)),
    ...(await readDeliveryRuns(db, deliveries.ids, 'deliveries', asOf)),
    ...(await readDeliveryRuns(db, publications.ids, 'publications', asOf)),
  ];
  const runs = new Map<string, StuckRun>();
  for (const row of rows) {
    if (row.since === null) continue;
    const since = new Date(row.since);
    const previous = runs.get(row.runId);
    if (previous === undefined || previous.since > since)
      runs.set(row.runId, { ...row, since });
  }
  const failed =
    failures.ids.length === 0
      ? []
      : await db
          .select({
            workspaceId: outboxEvents.workspaceId,
            outboxEventId: outboxEvents.id,
            jobName: outboxEvents.jobName,
            aggregateId: outboxEvents.aggregateId,
            failedAt: outboxEvents.failedAt,
            lastErrorCode: outboxEvents.lastErrorCode,
          })
          .from(outboxEvents)
          .where(
            and(
              inArray(outboxEvents.id, failures.ids),
              isNotNull(outboxEvents.failedAt),
            ),
          )
          .orderBy(asc(outboxEvents.failedAt), asc(outboxEvents.id))
          .catch(rethrowQueryFailure);
  const next = {
    asOf,
    leases: leases.next,
    deliveries: deliveries.next,
    publications: publications.next,
    failures: failures.next,
  };
  return Object.freeze({
    runs: [...runs.values()].sort(
      (a, b) =>
        a.since.getTime() - b.since.getTime() || a.runId.localeCompare(b.runId),
    ),
    failedOutboxEvents: failed.flatMap((event) =>
      event.failedAt === null ? [] : [{ ...event, failedAt: event.failedAt }],
    ),
    nextCursor: [
      leases.next,
      deliveries.next,
      publications.next,
      failures.next,
    ].some((position) => position !== null)
      ? encodeStuckWorkCursor(next)
      : null,
  });
}

async function readExpiredAttemptRuns(
  db: Pick<NodePgDatabase, 'select'>,
  ids: string[],
  asOf: string,
) {
  if (ids.length === 0) return [];
  return db
    .select({
      workspaceId: workflowRuns.workspaceId,
      runId: workflowRuns.id,
      status: workflowRuns.status,
      since: nodeAttempts.leaseExpiresAt,
    })
    .from(nodeAttempts)
    .innerJoin(
      nodeRuns,
      and(
        eq(nodeRuns.workspaceId, nodeAttempts.workspaceId),
        eq(nodeRuns.id, nodeAttempts.nodeRunId),
      ),
    )
    .innerJoin(
      workflowRuns,
      and(
        eq(workflowRuns.workspaceId, nodeRuns.workspaceId),
        eq(workflowRuns.id, nodeRuns.workflowRunId),
      ),
    )
    .where(
      and(
        inArray(nodeAttempts.id, ids),
        stalledLeaseEligible(nodeAttempts, sql`${asOf}::timestamptz`),
        stalledRunEligible(workflowRuns.status),
      ),
    )
    .catch(rethrowQueryFailure);
}

async function readDeliveryRuns(
  db: Pick<NodePgDatabase, 'select'>,
  ids: string[],
  lane: 'deliveries' | 'publications',
  asOf: string,
) {
  if (ids.length === 0) return [];
  const attempt = alias(nodeAttempts, 'event_attempt'),
    node = alias(nodeRuns, 'event_node');
  return db
    .select({
      workspaceId: workflowRuns.workspaceId,
      runId: workflowRuns.id,
      status: workflowRuns.status,
      since:
        lane === 'deliveries'
          ? outboxEvents.deliveryDueAt
          : sql<Date>`${outboxEvents.availableAt}+${UNPUBLISHED_RUN_JOB_GRACE}`,
    })
    .from(outboxEvents)
    .leftJoin(
      attempt,
      and(
        eq(outboxEvents.aggregateType, 'node-attempt'),
        eq(attempt.workspaceId, outboxEvents.workspaceId),
        eq(attempt.id, outboxEvents.aggregateId),
      ),
    )
    .leftJoin(
      node,
      and(
        eq(node.workspaceId, attempt.workspaceId),
        eq(node.id, attempt.nodeRunId),
      ),
    )
    .innerJoin(
      workflowRuns,
      and(
        eq(workflowRuns.workspaceId, outboxEvents.workspaceId),
        sql`${workflowRuns.id}=coalesce(${node.workflowRunId},${outboxEvents.aggregateId})`,
      ),
    )
    .where(
      and(
        inArray(outboxEvents.id, ids),
        stalledRunEligible(workflowRuns.status),
        lane === 'publications'
          ? stalledPublicationEligible(outboxEvents, sql`${asOf}::timestamptz`)
          : and(
              lte(outboxEvents.deliveryDueAt, sql`${asOf}::timestamptz`),
              stalledDeliveryUnconfirmed(db, outboxEvents, attempt.status),
            ),
      ),
    )
    .catch(rethrowQueryFailure);
}

async function databaseCursorTime(
  db: Pick<NodePgDatabase, 'select'>,
): Promise<string> {
  const [clock] = await db
    .select({
      time: sql<string>`to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(sql`(values (1)) as clock(one)`)
    .catch(rethrowQueryFailure);
  if (clock === undefined) throw new Error('Database clock returned no value');
  return clock.time;
}
