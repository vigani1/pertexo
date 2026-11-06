import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { databaseSchema } from '@pertexo/database/schema';
import { workspaceInboxFailureDays as failureDays } from '@pertexo/database/schema';

type FailureDay = Readonly<{ day: string; count: number }>;

/** A bounded, UTC, retained-run history for every workflow in one Inbox page. */
export async function readFailureDays(
  db: NodePgDatabase<typeof databaseSchema>,
  workspaceId: string,
  workflowIds: readonly string[],
): Promise<ReadonlyMap<string, readonly FailureDay[]>> {
  if (workflowIds.length === 0) return new Map();
  const day = failureDays.day;
  const rows = await db
    .select({
      workflowId: failureDays.workflowId,
      day,
      count: sql<number>`${failureDays.count}::integer`,
    })
    .from(failureDays)
    .where(
      and(
        eq(failureDays.workspaceId, workspaceId),
        inArray(failureDays.workflowId, [...workflowIds]),
        gte(
          failureDays.day,
          sql`(transaction_timestamp() at time zone 'UTC')::date-29`,
        ),
        lte(
          failureDays.day,
          sql`(transaction_timestamp() at time zone 'UTC')::date`,
        ),
      ),
    )
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
