import { ordinaryRunSql } from '../../runs/data-policy.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { databaseSchema } from '../../schema.js';
import { workflowRuns } from '../../schema/runs/execution.js';

type FailureDay = Readonly<{ day: string; count: number }>;

/** A bounded, UTC, retained-run history for every workflow in one Inbox page. */
export async function readFailureDays(
  db: NodePgDatabase<typeof databaseSchema>,
  workspaceId: string,
  workflowIds: readonly string[],
): Promise<ReadonlyMap<string, readonly FailureDay[]>> {
  if (workflowIds.length === 0) return new Map();
  const day = sql<string>`to_char(${workflowRuns.completedAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      workflowId: workflowRuns.workflowId,
      day,
      count: sql<number>`count(*)::integer`,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, workspaceId),
        ordinaryRunSql('workflow_runs'),
        inArray(workflowRuns.workflowId, [...workflowIds]),
        inArray(workflowRuns.status, [
          'failed',
          'timed_out',
          'outcome_unknown',
        ]),
        gte(
          workflowRuns.completedAt,
          sql`(date_trunc('day', transaction_timestamp() at time zone 'UTC') - interval '29 days') at time zone 'UTC'`,
        ),
        lte(workflowRuns.completedAt, sql`transaction_timestamp()`),
      ),
    )
    .groupBy(workflowRuns.workflowId, day)
    .orderBy(day)
    .catch(rethrowQueryFailure);
  const grouped = new Map<string, FailureDay[]>();
  for (const row of rows) {
    const days = grouped.get(row.workflowId) ?? [];
    days.push({ day: row.day, count: row.count });
    grouped.set(row.workflowId, days);
  }
  return grouped;
}
