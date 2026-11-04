import { and, eq, inArray, lte, min, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  nodeAttempts,
  nodeRuns,
  workflowRuns,
  outboxEvents,
} from '@pertexo/database/schema';
import { RUN_DELIVERY_JOB_NAMES } from '../../outbox/delivery-consumers.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  stalledRunEligible,
  stalledLeaseEligible,
  stalledPublicationEligible,
  stalledDeliveryUnconfirmed,
  UNPUBLISHED_RUN_JOB_GRACE,
} from './stalled-eligibility.repository.js';

/**
 * The moment each active run's next step passed its time, for one run.
 * Shares eligibility with the paged operator list. The scanner acts on this
 * work, so a
 * row that lingers means no worker is acting. A run stuck on an attempt's job
 * carries the job's attempt as its aggregate, hence the two joins.
 */
function overdueRunSteps(
  db: Pick<NodePgDatabase, 'select'>,
  scope: Readonly<{ workspaceId: string; runId: string }>,
) {
  const inScope = and(
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
        stalledLeaseEligible(attempt, sql`clock_timestamp()`),
        stalledRunEligible(workflowRuns.status),
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
        sql<Date>`coalesce(${event.deliveryDueAt},${event.availableAt}+${UNPUBLISHED_RUN_JOB_GRACE})`.as(
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
            stalledDeliveryUnconfirmed(db, event, eventAttempt.status),
          ),
          stalledPublicationEligible(event, sql`clock_timestamp()`),
        ),
        stalledRunEligible(workflowRuns.status),
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
