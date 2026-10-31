import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  min,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  nodeAttempts,
  nodeRuns,
  workflowRuns,
} from '../../schema/runs/execution.js';
import { inboxReceipts, outboxEvents } from '../../schema/transport.js';
import { RUN_DELIVERY_JOB_NAMES } from '../../outbox/dispatcher/repository.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { coordinatorConsumerName } from '../advance/receipts.repository.js';
import type { StuckWork } from './contract.js';

const ACTIVE_STATUSES = ['running', 'waiting'] as const;

/** An unpublished run job this overdue means the dispatcher can't reach Redis. */
const UNPUBLISHED_GRACE = sql`interval '60 seconds'`;

/**
 * The moment each active run's next step passed its time, for one run or all.
 * This is the single definition of "stalled"; the run read and the operator list
 * both read it. Anything here is also what the scanner is about to act on, so a
 * row that lingers means no worker is acting. A run stuck on an attempt's job
 * carries the job's attempt as its aggregate, hence the two joins.
 */
export function overdueRunSteps(
  db: Pick<NodePgDatabase, 'select'>,
  scope: Readonly<{ workspaceId: string; runId: string }> | undefined,
) {
  const inScope =
    scope === undefined
      ? undefined
      : and(
          eq(workflowRuns.workspaceId, scope.workspaceId),
          eq(workflowRuns.id, scope.runId),
        );
  const attempt = alias(nodeAttempts, 'attempt');
  const node = alias(nodeRuns, 'node');
  const expiredLeases = db
    .select({
      workspaceId: workflowRuns.workspaceId,
      runId: workflowRuns.id,
      status: workflowRuns.status,
      since: sql<Date>`${attempt.leaseExpiresAt}`.as('since'),
    })
    .from(attempt)
    .innerJoin(
      node,
      and(
        eq(node.workspaceId, attempt.workspaceId),
        eq(node.id, attempt.nodeRunId),
      ),
    )
    .innerJoin(
      workflowRuns,
      and(
        eq(workflowRuns.workspaceId, node.workspaceId),
        eq(workflowRuns.id, node.workflowRunId),
      ),
    )
    .where(
      and(
        eq(attempt.status, 'running'),
        lte(attempt.leaseExpiresAt, sql`clock_timestamp()`),
        inArray(workflowRuns.status, ACTIVE_STATUSES),
        inScope,
      ),
    );

  const event = alias(outboxEvents, 'event');
  const eventAttempt = alias(nodeAttempts, 'event_attempt');
  const eventNode = alias(nodeRuns, 'event_node');
  const overdueEvents = db
    .select({
      workspaceId: workflowRuns.workspaceId,
      runId: workflowRuns.id,
      status: workflowRuns.status,
      since:
        sql<Date>`coalesce(${event.deliveryDueAt},${event.availableAt}+${UNPUBLISHED_GRACE})`.as(
          'since',
        ),
    })
    .from(event)
    .leftJoin(
      eventAttempt,
      and(
        eq(event.aggregateType, 'node-attempt'),
        eq(eventAttempt.workspaceId, event.workspaceId),
        eq(eventAttempt.id, event.aggregateId),
      ),
    )
    .leftJoin(
      eventNode,
      and(
        eq(eventNode.workspaceId, eventAttempt.workspaceId),
        eq(eventNode.id, eventAttempt.nodeRunId),
      ),
    )
    .innerJoin(
      workflowRuns,
      and(
        eq(workflowRuns.workspaceId, event.workspaceId),
        sql`${workflowRuns.id}=coalesce(${eventNode.workflowRunId},${event.aggregateId})`,
      ),
    )
    .where(
      and(
        inArray(event.jobName, RUN_DELIVERY_JOB_NAMES),
        or(
          and(
            lte(event.deliveryDueAt, sql`clock_timestamp()`),
            // A due row the scan hasn't cleared yet says nothing by itself: an
            // attempt's job only matters while it is ready, and an advance's
            // until its consumer confirms it.
            or(
              eq(eventAttempt.status, 'ready'),
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
            ),
          ),
          and(
            isNull(event.publishedAt),
            isNull(event.failedAt),
            lte(
              event.availableAt,
              sql`clock_timestamp()-${UNPUBLISHED_GRACE}`,
            ),
          ),
        ),
        inArray(workflowRuns.status, ACTIVE_STATUSES),
        inScope,
      ),
    );
  return expiredLeases.unionAll(overdueEvents).as('overdue_step');
}


/** When a run's next step passed its time, or undefined for a healthy run. */
export async function readRunStalledSince(
  db: Pick<NodePgDatabase, 'select'>,
  scope: Readonly<{ workspaceId: string; runId: string }>,
): Promise<Date | undefined> {
  const overdue = overdueRunSteps(db, scope);
  const [row] = await db
    .select({ since: min(overdue.since) })
    .from(overdue)
    .catch(rethrowQueryFailure);
  return row?.since === null || row?.since === undefined
    ? undefined
    : new Date(row.since);
}

const STUCK_LIST_LIMIT = 200;

/** Every stuck run and failed outbox event, across workspaces, for the operator. */
export async function readStuckWork(
  db: Pick<NodePgDatabase, 'select'>,
): Promise<StuckWork> {
  const overdue = overdueRunSteps(db, undefined);
  const runs = await db
    .select({
      workspaceId: overdue.workspaceId,
      runId: overdue.runId,
      status: overdue.status,
      since: min(overdue.since),
    })
    .from(overdue)
    .groupBy(overdue.workspaceId, overdue.runId, overdue.status)
    .orderBy(min(overdue.since))
    .limit(STUCK_LIST_LIMIT)
    .catch(rethrowQueryFailure);
  const failed = await db
    .select({
      workspaceId: outboxEvents.workspaceId,
      outboxEventId: outboxEvents.id,
      jobName: outboxEvents.jobName,
      aggregateId: outboxEvents.aggregateId,
      failedAt: outboxEvents.failedAt,
      lastErrorCode: outboxEvents.lastErrorCode,
    })
    .from(outboxEvents)
    .where(isNotNull(outboxEvents.failedAt))
    .orderBy(desc(outboxEvents.failedAt))
    .limit(STUCK_LIST_LIMIT)
    .catch(rethrowQueryFailure);
  return Object.freeze({
    runs: runs.flatMap((run) =>
      run.since === null ? [] : [{ ...run, since: new Date(run.since) }],
    ),
    failedOutboxEvents: failed.flatMap((event) =>
      event.failedAt === null ? [] : [{ ...event, failedAt: event.failedAt }],
    ),
  });
}
