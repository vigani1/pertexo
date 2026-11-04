import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

type Executor = Pick<NodePgDatabase, 'execute'>;

/**
 * Shares the workspace row. Lifecycle and purge hold it before run rows, so this
 * comes before any run, checkpoint or foreign-key write. Returns the workspace's
 * status, or undefined for one that isn't there.
 */
export async function lockWorkspaceRunAdmission(
  db: Executor,
  workspaceId: string,
): Promise<string | undefined> {
  const result = await db
    .execute<{ status: string | null }>(
      sql`select app.lock_workspace_run_admission(${workspaceId}) status`,
    )
    .catch(rethrowQueryFailure);
  return result.rows[0]?.status ?? undefined;
}
