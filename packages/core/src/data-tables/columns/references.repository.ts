import { sql, and, eq } from 'drizzle-orm';
import { workflowVersions } from '@pertexo/database/schema';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import type { ReferenceNode } from './table-references.js';

/** The version's top-level nodes, or null/undefined when it has none or is gone. */
export async function readVersionNodes(
  transaction: WorkspaceTransaction,
  workflowVersionId: string,
): Promise<readonly ReferenceNode[] | null | undefined> {
  const [version] = await transaction.db
    .select({
      nodes: sql<
        readonly ReferenceNode[] | null
      >`${workflowVersions.graphJson}->'nodes'`,
    })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workspaceId, transaction.workspaceId),
        eq(workflowVersions.id, workflowVersionId),
      ),
    );
  return version?.nodes;
}
