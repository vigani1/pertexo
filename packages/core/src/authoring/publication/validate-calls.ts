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

import { projectVersion } from '../workflows/representation/workflow-representations.repository.js';
import { readPinnedVersion } from './calls.repository.js';

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
        const row = await readPinnedVersion(client, identity.workspaceId, pin);
        if (row === undefined) throw new WorkflowCallDependencyError('pin');
        const version = projectVersion(row);
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
