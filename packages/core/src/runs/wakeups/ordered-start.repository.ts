import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

/**
 * Called in the transaction that starts `runId`. A limited workflow's granted runs
 * start in ticket order, so a later one that tried first was deferred while still
 * holding its slot. Now that the run ahead of it has started, it needn't wait out
 * the deferral. The deferral stays the fallback when the run ahead is stuck.
 */
export async function wakeNextOrderedStart(
  client: PoolClient,
  workspaceId: string,
  runId: string,
): Promise<void> {
  await drizzle(client)
    .execute(
      sql`select app.wake_next_ordered_workflow_run_start(${workspaceId},${runId})`,
    )
    .catch(rethrowQueryFailure);
}
