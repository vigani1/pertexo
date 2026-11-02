import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ResourceTransaction } from '../../../shared/contract.js';
import { workflowScopeSql } from '../../../shared/scope.queries.js';
import { workflowRuns, workflows, usageEvents } from '@pertexo/database/schema';
import { ordinaryRunSql } from '../../data-policy.js';

function runWindow(transaction: ResourceTransaction, hours: number) {
  return and(
    ordinaryRunSql('workflow_runs'),
    eq(workflowRuns.workspaceId, transaction.workspaceId),
    workflowScopeSql(transaction.resources, sql`${workflowRuns.workflowId}`),
    sql`${workflowRuns.createdAt}>=transaction_timestamp()-make_interval(hours=>${hours}::integer)`,
    sql`${workflowRuns.createdAt}<transaction_timestamp()`,
  );
}
export async function readStatisticsCounts(
  transaction: ResourceTransaction,
  hours: number,
) {
  const { db } = transaction;
  const [current] = await db
    .select({
      as_of: sql<string>`to_char(transaction_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      created_at_from: sql<string>`to_char((transaction_timestamp()-make_interval(hours=>${hours}::integer)) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      queued: sql<number>`count(*) filter(where ${workflowRuns.status}='queued')::integer`,
      running: sql<number>`count(*) filter(where ${workflowRuns.status}='running')::integer`,
      waiting: sql<number>`count(*) filter(where ${workflowRuns.status}='waiting')::integer`,
    })
    .from(workflowRuns)
    .where(
      and(
        ordinaryRunSql('workflow_runs'),
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        workflowScopeSql(
          transaction.resources,
          sql`${workflowRuns.workflowId}`,
        ),
        inArray(workflowRuns.status, ['queued', 'running', 'waiting']),
      ),
    );
  const statuses = await db
    .select({
      status: workflowRuns.status,
      run_count: sql<number>`count(*)::integer`,
    })
    .from(workflowRuns)
    .where(runWindow(transaction, hours))
    .groupBy(workflowRuns.status);
  const [skipped] = await db
    .select({
      count: sql<number>`count(*) filter(where ${usageEvents.category}='trigger.skipped')::integer`,
      coordinated: sql<number>`count(*) filter(where ${usageEvents.category}='trigger.coordinated')::integer`,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.workspaceId, transaction.workspaceId),
        workflowScopeSql(transaction.resources, sql`${usageEvents.resourceId}`),
        inArray(usageEvents.category, [
          'trigger.skipped',
          'trigger.coordinated',
        ]),
        sql`${usageEvents.occurredAt}>=transaction_timestamp()-make_interval(hours=>${hours}::integer)`,
        sql`${usageEvents.occurredAt}<transaction_timestamp()`,
      ),
    );
  if (current === undefined || skipped === undefined)
    throw new Error('Run statistics aggregation returned no row');
  return { current, statuses, skipped };
}
export function readWorkflowBreakdownRows(
  transaction: ResourceTransaction,
  {
    hours,
    includeWorkflowName,
    limit,
  }: Readonly<{ hours: number; includeWorkflowName: boolean; limit: number }>,
) {
  const { db } = transaction;
  const windowCounts = db.$with('window_counts').as(
    db
      .select({
        workflow_id: workflowRuns.workflowId,
        status: workflowRuns.status,
        run_count: sql<number>`count(*)::integer`.as('run_count'),
      })
      .from(workflowRuns)
      .where(runWindow(transaction, hours))
      .groupBy(workflowRuns.workflowId, workflowRuns.status),
  );
  const total = sql<number>`sum(${windowCounts.run_count})::integer`.as(
    'total',
  );
  const ranked = db
    .$with('ranked')
    .as(
      db
        .select({ workflow_id: windowCounts.workflow_id, total })
        .from(windowCounts)
        .groupBy(windowCounts.workflow_id)
        .orderBy(desc(total), asc(windowCounts.workflow_id))
        .limit(limit),
    );
  return db
    .with(windowCounts, ranked)
    .select({
      workflow_id: ranked.workflow_id,
      total: ranked.total,
      status: windowCounts.status,
      run_count: windowCounts.run_count,
      workflow_name: includeWorkflowName
        ? workflows.name
        : sql<string | null>`null`,
    })
    .from(ranked)
    .innerJoin(windowCounts, eq(windowCounts.workflow_id, ranked.workflow_id))
    .leftJoin(
      workflows,
      and(
        eq(workflows.workspaceId, transaction.workspaceId),
        eq(workflows.id, ranked.workflow_id),
      ),
    )
    .orderBy(
      desc(ranked.total),
      asc(ranked.workflow_id),
      asc(windowCounts.status),
    );
}
