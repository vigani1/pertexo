import { workflowInputCasePayloads } from '@pertexo/database/schema';
import { and, asc, eq, exists, lte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

/** One page of stored input payloads: at most this many, and this many bytes. */
const INPUT_PAYLOAD_PAGE = Object.freeze({ rows: 100, bytes: 1_048_576 });

export async function purgeInputPayloads(
  client: PoolClient,
  workspaceId: string,
  pageSize: number,
): Promise<number> {
  const db = drizzle(client);
  const page = db.$with('page').as(
    db
      .select({
        caseId: workflowInputCasePayloads.caseId,
        revision: workflowInputCasePayloads.revision,
        bytes:
          sql<number>`sum(${workflowInputCasePayloads.canonicalBytes}) over (order by ${workflowInputCasePayloads.caseId},${workflowInputCasePayloads.revision})`.as(
            'bytes',
          ),
      })
      .from(workflowInputCasePayloads)
      .where(eq(workflowInputCasePayloads.workspaceId, workspaceId))
      .orderBy(
        asc(workflowInputCasePayloads.caseId),
        asc(workflowInputCasePayloads.revision),
      )
      .limit(Math.min(pageSize, INPUT_PAYLOAD_PAGE.rows)),
  );
  return (
    await db
      .with(page)
      .delete(workflowInputCasePayloads)
      .where(
        and(
          eq(workflowInputCasePayloads.workspaceId, workspaceId),
          exists(
            db
              .select({ one: sql`1` })
              .from(page)
              .where(
                and(
                  eq(page.caseId, workflowInputCasePayloads.caseId),
                  eq(page.revision, workflowInputCasePayloads.revision),
                  lte(page.bytes, INPUT_PAYLOAD_PAGE.bytes),
                ),
              ),
          ),
        ),
      )
      .returning({ one: sql`1` })
      .catch(rethrowQueryFailure)
  ).length;
}
