import type { PoolClient } from 'pg';
import type { WorkflowGraph } from '@pertexo/workflow-model';
/** Publication cannot silently transfer a public grant to a replacement entry. */
export async function revokeRemovedFormAccess(
  client: Pick<PoolClient, 'query'>,
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
  await client.query(
    `update app.workflow_forms set access='members',capability_hash=null,revision=revision+1,updated_at=clock_timestamp()
    where workspace_id=$1 and workflow_id=$2 and access='public' and node_id is distinct from $3::varchar`,
    [workspaceId, workflowId, entry?.id ?? null],
  );
}
