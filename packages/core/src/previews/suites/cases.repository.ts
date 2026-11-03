import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { workflowTestSuiteCases } from '@pertexo/database/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

/** A stopped or canceled suite won't reach these. */
export async function skipPendingCases(
  client: PoolClient,
  workspaceId: string,
  suiteId: string,
): Promise<void> {
  await drizzle(client)
    .update(workflowTestSuiteCases)
    .set({ status: 'skipped' })
    .where(
      and(
        eq(workflowTestSuiteCases.workspaceId, workspaceId),
        eq(workflowTestSuiteCases.suiteId, suiteId),
        eq(workflowTestSuiteCases.status, 'pending'),
      ),
    )
    .catch(rethrowQueryFailure);
}
