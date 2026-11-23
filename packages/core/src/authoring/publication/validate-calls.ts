import type { PoolClient } from 'pg';

import {
  InvalidWorkflowGraphError,
  agentCallSetups,
  callableObjectInputSchema,
  canonicalJson,
  type CallableType,
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
  const agentContracts = new Map<string, CallableType[]>();
  const graphs = [graph];
  for (const current of graphs)
    for (const node of current.nodes) {
      if (node.structured !== undefined) graphs.push(node.structured.body);
      for (const call of agentCallSetups(node)) {
        const contracts =
          agentContracts.get(call.target.workflowVersionId) ?? [];
        contracts.push(call.input);
        agentContracts.set(call.target.workflowVersionId, contracts);
      }
    }
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
        const agentInputs = agentContracts.get(pin.workflowVersionId);
        if (
          agentInputs !== undefined &&
          (callableObjectInputSchema(version.graphJson.callable.input) ===
            undefined ||
            agentInputs.some(
              (input) =>
                canonicalJson(input) !==
                canonicalJson(version.graphJson.callable?.input),
            ))
        )
          throw new InvalidWorkflowGraphError([
            {
              code: 'invalid_graph',
              path: '$.nodes',
              message:
                'Agent Call tools must use the pinned version’s object input contract.',
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
