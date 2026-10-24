import type { PoolClient } from 'pg';
import {
  InvalidWorkflowGraphError,
  summarizeWorkflowCalls,
  validateCallDependencyClosure,
  validateWorkflowGraph,
  WORKFLOW_GRAPH_LIMITS,
  WorkflowCallDependencyError,
  type CallableVersionSummary,
  type WorkflowCallPin,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import {
  mapVersion,
  workflowVersionRowSelection,
} from '../workflows/representation/records.queries.js';

/** Current author authority is fenced by publication; RLS scopes every target read. */
export async function validatePublicationCalls(
  client: PoolClient,
  identity: WorkflowCallPin & Readonly<{ workspaceId: string }>,
  graph: WorkflowGraph,
  expandedInvocations: number,
): Promise<CallableVersionSummary> {
  const root = summarizeWorkflowCalls(identity, graph, expandedInvocations);
  try {
    await validateCallDependencyClosure(
      root,
      async (pin) => {
        const result = await client.query<Record<string, unknown>>(
          `select ${workflowVersionRowSelection} from app.workflow_versions
         where workspace_id=$1 and workflow_id=$2 and id=$3`,
          [identity.workspaceId, pin.workflowId, pin.workflowVersionId],
        );
        const row = result.rows[0];
        if (row === undefined) throw new WorkflowCallDependencyError('pin');
        const version = mapVersion(row);
        if (version.graphJson.callable === undefined)
          throw new InvalidWorkflowGraphError([
            {
              code: 'invalid_graph',
              path: '$.nodes',
              message: 'Call targets must declare a callable contract.',
            },
          ]);
        const validation = validateWorkflowGraph(version.graphJson);
        if (!validation.ok)
          throw new InvalidWorkflowGraphError(validation.issues);
        return summarizeWorkflowCalls(
          {
            workspaceId: version.workspaceId,
            workflowId: version.workflowId,
            workflowVersionId: version.id,
            executableChecksum: version.checksum,
          },
          version.graphJson,
          validation.expandedInvocations,
        );
      },
      WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations,
    );
  } catch (error) {
    if (!(error instanceof WorkflowCallDependencyError)) throw error;
    const message = {
      workspace: 'Call targets must belong to this workspace.',
      pin: 'Call targets must pin a visible published version and its exact executable checksum.',
      cycle:
        'Call dependencies cannot repeat an ancestor workflow, including another version.',
      expansion: `Call dependency expansion exceeds ${String(WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations)} invocations.`,
    }[error.code];
    throw new InvalidWorkflowGraphError([
      {
        code: error.code === 'expansion' ? 'expansion_limit' : 'invalid_graph',
        path: '$.nodes',
        message,
      },
    ]);
  }
  return root;
}

export async function persistPublicationCalls(
  client: PoolClient,
  workspaceId: string,
  parentVersionId: string,
  calls: CallableVersionSummary['calls'],
): Promise<void> {
  for (const { nodeId, pin } of calls)
    await client.query(
      `insert into app.workflow_version_dependencies
        (workspace_id,parent_version_id,node_id,target_workflow_id,target_version_id)
       values($1,$2,$3,$4,$5) on conflict do nothing`,
      [
        workspaceId,
        parentVersionId,
        nodeId,
        pin.workflowId,
        pin.workflowVersionId,
      ],
    );
}
