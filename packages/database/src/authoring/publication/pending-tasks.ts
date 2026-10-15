import type { PoolClient } from 'pg';
import {
  approvalConfigSchema,
  inputRequestConfigSchema,
  InvalidWorkflowGraphError,
  isHumanTaskDefinition,
  type WorkflowGraph,
} from '@pertexo/workflow-model';

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
      if (!isHumanTaskDefinition(node.definition)) continue;
      const config = (
        node.definition.key === 'core.approval'
          ? approvalConfigSchema
          : inputRequestConfigSchema
      ).parse(node.config);
      for (const id of config.audience.memberIds)
        members.set(id, [
          ...(members.get(id) ?? []),
          `${path}.config.audience.memberIds`,
        ]);
    }
  if (members.size === 0) return;
  const result = await client.query<{ user_id: string }>(
    `select member.user_id from app.workspace_memberships member join app.users actor on actor.id=member.user_id and actor.status='active' where member.workspace_id=$1 and member.user_id=any($2::uuid[]) and member.status='active' order by member.user_id for share of member,actor`,
    [workspaceId, [...members.keys()].sort()],
  );
  const active = new Set(result.rows.map((row) => row.user_id));
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
