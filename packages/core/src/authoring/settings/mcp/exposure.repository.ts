import { and, eq, ne, sql } from 'drizzle-orm';
import { workflows } from '@pertexo/database/schema';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';

type Exposure = (typeof workflows.$inferInsert)['mcpExposure'];

export async function mcpToolNameInUse(
  transaction: WorkspaceTransaction,
  workflowId: string,
  name: string,
) {
  const [row] = await transaction.db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, transaction.workspaceId),
        ne(workflows.id, workflowId),
        sql`${workflows.mcpExposure}->>'versionId'=${workflows.publishedVersionId}::text`,
        sql`${workflows.mcpExposure}->>'name'=${name}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function writeMcpExposure(
  transaction: WorkspaceTransaction,
  workflowId: string,
  exposure: NonNullable<Exposure> | null,
) {
  await transaction.db
    .update(workflows)
    .set({ mcpExposure: exposure })
    .where(
      and(
        eq(workflows.workspaceId, transaction.workspaceId),
        eq(workflows.id, workflowId),
      ),
    );
}
