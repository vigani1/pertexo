import type { PoolClient } from 'pg';

import {
  approvalConfigSchema,
  agentConfigSchema,
  inputRequestConfigSchema,
  InvalidWorkflowGraphError,
  isHumanTaskDefinition,
  isAgentDefinition,
  type WorkflowGraph,
  type WorkflowNode,
} from '@pertexo/workflow-model';

import { shareLockActiveMembers } from './pending-tasks.repository.js';

/** Publication fences named members; role eligibility remains current at decision. */
export async function validateApprovalAudience(
  client: PoolClient,
  workspaceId: string,
  graph: WorkflowGraph,
): Promise<void> {
  const members = new Map<string, string[]>();
  const levels: { nodes: WorkflowGraph['nodes']; path: string }[] = [
    { nodes: graph.nodes, path: '$' },
  ];
  for (const level of levels)
    for (const [index, node] of level.nodes.entries()) {
      const path = `${level.path}.nodes[${String(index)}]`;
      if (node.structured !== undefined)
        levels.push({
          nodes: node.structured.body.nodes,
          path: `${path}.structured.body`,
        });
      const task = taskAudience(node);
      if (task === undefined) continue;
      for (const id of task.audience.memberIds)
        members.set(id, [...(members.get(id) ?? []), `${path}.${task.path}`]);
    }
  if (members.size === 0) return;
  const result = await shareLockActiveMembers(client, workspaceId, [
    ...members.keys(),
  ]);
  const active = new Set(result.map((row) => row.userId));
  const issues = [...members].flatMap(([id, paths]) =>
    active.has(id)
      ? []
      : paths.map((path) => ({
          code: 'invalid_graph' as const,
          path,
          message:
            'Choose active members of this workspace for the task audience.',
        })),
  );
  if (issues.length > 0) throw new InvalidWorkflowGraphError(issues);
}

function taskAudience(node: WorkflowNode) {
  if (isAgentDefinition(node.definition)) {
    const settings = agentConfigSchema.safeParse(node.config);
    if (!settings.success) return undefined;
    const { tool } = settings.data;
    if ('writePermission' in tool && tool.writePermission.kind === 'approval')
      return {
        audience: tool.writePermission.config.audience,
        path: 'config.tool.writePermission.config.audience.memberIds',
      };
    return undefined;
  }
  if (!isHumanTaskDefinition(node.definition)) return undefined;
  const { audience } = (
    node.definition.key === 'core.approval'
      ? approvalConfigSchema
      : inputRequestConfigSchema
  ).parse(node.config);
  return { audience, path: 'config.audience.memberIds' };
}
