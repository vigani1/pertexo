import { and, eq, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflows } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

/** Whether another target workflow already has this name (0 or 1). */
export async function countNameCollisions(
  client: PoolClient,
  workspaceId: string,
  {
    name,
    exceptWorkflowId,
  }: Readonly<{ name: string; exceptWorkflowId: string | undefined }>,
): Promise<number> {
  const found = await drizzle(client)
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, workspaceId),
        eq(workflows.name, name),
        exceptWorkflowId === undefined
          ? undefined
          : ne(workflows.id, exceptWorkflowId),
      ),
    )
    .limit(1)
    .catch(rethrowQueryFailure);
  return found.length;
}
