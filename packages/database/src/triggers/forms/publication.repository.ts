import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowForms } from '../../schema/triggers/forms.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { Client, PoolClient } from 'pg';
import type { WorkflowGraph } from '@pertexo/workflow-model';
/** Publication cannot silently transfer a public grant to a replacement entry. */
export async function revokeRemovedFormAccess(
  client: Client | PoolClient,
  workspaceId: string,
  workflowId: string,
  graph: WorkflowGraph,
): Promise<void> {
  const entry = graph.nodes.find(
    (node) =>
      node.definition.key === 'core.form' &&
      node.definition.version === 1 &&
      !(node.disabled ?? false),
  );
  await drizzle(client)
    .update(workflowForms)
    .set({
      access: 'members',
      capabilityHash: null,
      revision: sql`${workflowForms.revision}+1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workflowForms.workspaceId, workspaceId),
        eq(workflowForms.workflowId, workflowId),
        eq(workflowForms.access, 'public'),
        sql`${workflowForms.nodeId} is distinct from ${entry?.id ?? null}::varchar`,
      ),
    )
    .catch(rethrowQueryFailure);
}
