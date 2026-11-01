import { and, asc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { workspaceMemberships, users } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
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
  const member = alias(workspaceMemberships, 'member');
  const actor = alias(users, 'actor');
  const result = await drizzle(client)
    .select({ userId: member.userId })
    .from(member)
    .innerJoin(
      actor,
      and(eq(actor.id, member.userId), eq(actor.status, 'active')),
    )
    .where(
      and(
        eq(member.workspaceId, workspaceId),
        inArray(member.userId, [...members.keys()].sort()),
        eq(member.status, 'active'),
      ),
    )
    .orderBy(asc(member.userId))
    .for('share', { of: [member, actor] })
    .catch(rethrowQueryFailure);
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
